/**
 * Apply orphandedupe by scope against PROD (.env).
 * Usage:
 *   node scripts/novo-crm-orphan-dedupe-scope-apply.mjs incomplete
 *   node scripts/novo-crm-orphan-dedupe-scope-apply.mjs duplicates
 *   node scripts/novo-crm-orphan-dedupe-scope-apply.mjs orphans
 *
 * Env:
 *   NOVO_CRM_ORPHAN_PROVISION_CONCURRENCY (default 3 for incomplete/duplicates)
 *   NOVO_CRM_API_RATE_PER_SECOND (default 3)
 *   ORPHAN_MAX (max creates when scope includes orphans)
 *   MAX_ORPHAN_CREATE_SAFETY (skip orphans apply if would_create est > this; only for orphans dry estimate N/A)
 */
import 'dotenv/config';
import fs from 'node:fs';

const scopeArg = String(process.argv[2] || 'incomplete').trim().toLowerCase();
if (!['incomplete', 'duplicates', 'orphans', 'both'].includes(scopeArg)) {
  console.error('Usage: … <incomplete|duplicates|orphans|both>');
  process.exit(2);
}

process.env.NOVO_CRM_PROVISION_ALLOW_PROD = process.env.NOVO_CRM_PROVISION_ALLOW_PROD || '1';
// Modest concurrent write for incompletes — plan says keep ~3, rate 2–3
if (!process.env.NOVO_CRM_ORPHAN_PROVISION_CONCURRENCY) {
  process.env.NOVO_CRM_ORPHAN_PROVISION_CONCURRENCY = '3';
}
if (!process.env.NOVO_CRM_API_RATE_PER_SECOND) {
  process.env.NOVO_CRM_API_RATE_PER_SECOND = '3';
}
process.env.NOVO_CRM_ORPHAN_LIVE_CHECK = process.env.NOVO_CRM_ORPHAN_LIVE_CHECK || '1';
process.env.NOVO_CRM_ORPHAN_SKIP_FIELDS = process.env.NOVO_CRM_ORPHAN_SKIP_FIELDS || '0';
// Cap de moves→Perdido no pass de duplicates (service default 1000 — baixo p/ PRD em lote).
if (
  (scopeArg === 'duplicates' || scopeArg === 'both') &&
  !process.env.NOVO_CRM_DEDUPE_MAX_MOVES
) {
  process.env.NOVO_CRM_DEDUPE_MAX_MOVES = '15000';
}
if (!process.env.ORPHAN_MAX && (scopeArg === 'incomplete' || scopeArg === 'duplicates')) {
  // incompletes/duplicados não criam deal em massa; default script antigo era 200
  process.env.ORPHAN_MAX = '500';
}

const stamp = Date.now();
const logPath = `data/orphan-dedupe-apply-${scopeArg}-${stamp}.log`;
const outPath = `data/orphan-dedupe-apply-${scopeArg}-${stamp}.json`;

function log(...args) {
  const line = `[${new Date().toISOString()}] ${args.map(String).join(' ')}`;
  console.log(line);
  fs.appendFileSync(logPath, `${line}\n`);
}

const { getNovoCrmStageIds } = await import('../server/utils/novoCrmStageRules.js');
const { isNovoCrmWriteAllowedOnThisHost } = await import(
  '../server/services/novoCrmMatriculadosProvisionService.js'
);
const {
  startOrphanAlunoProvisionApplyBackground,
  getOrphanAlunoProvisionJob,
  getRunningOrphanAlunoProvisionJob,
  requestCancelOrphanAlunoProvision,
} = await import('../server/services/novoCrmOrphanAlunoProvisionService.js');

const stageIds = getNovoCrmStageIds();
log('SCOPE', scopeArg);
log('CRM', process.env.NOVO_CRM_API_BASE_URL);
log('writeAllowed', isNovoCrmWriteAllowedOnThisHost());
log(
  'rate',
  process.env.NOVO_CRM_API_RATE_PER_SECOND,
  'conc',
  process.env.NOVO_CRM_ORPHAN_PROVISION_CONCURRENCY,
  'liveCheck',
  process.env.NOVO_CRM_ORPHAN_LIVE_CHECK
);

if (!isNovoCrmWriteAllowedOnThisHost()) {
  log('ABORT write gate');
  process.exit(1);
}
if (!String(stageIds['Graduação'] || '').startsWith('cmrwd5vun')) {
  log('ABORT unexpected Graduação stage id', stageIds['Graduação']);
  process.exit(1);
}

const running = getRunningOrphanAlunoProvisionJob();
if (running) {
  log('ABORT already running in this process', running.jobId, running.scope, running.phase);
  process.exit(1);
}

const maxCreates = Number(process.env.ORPHAN_MAX || 200) || 200;
// Safety: orphans apply with low max by default (create only if truly needed)
const effectiveMax = scopeArg === 'orphans' || scopeArg === 'both' ? maxCreates : maxCreates;

log('START apply dry=0 scope=', scopeArg, 'maxCreates=', effectiveMax);

const start = startOrphanAlunoProvisionApplyBackground({
  maxCreates: effectiveMax,
  scope: scopeArg,
  dryRun: false,
});
if (!start.started) {
  log('ABORT already running', start.jobId, start.error);
  process.exit(1);
}
log('jobId', start.jobId);

const t0 = Date.now();
let lastLog = 0;
for (;;) {
  await new Promise((r) => setTimeout(r, 15000));
  const job = getOrphanAlunoProvisionJob(start.jobId);
  if (!job) {
    log('ABORT job disappeared');
    process.exit(1);
  }
  const now = Date.now();
  if (now - lastLog > 55000 || job.status !== 'running') {
    lastLog = now;
    log(
      'progress',
      `status=${job.status}`,
      `phase=${job.phase}`,
      `proc=${job.processed}/${job.total}`,
      `inc=${job.incomplete_processed}/${job.incomplete_total}`,
      `orph=${job.orphans_processed}/${job.orphans_total}`,
      `dupG=${job.dup_groups_processed}/${job.dup_groups}`,
      `sent=${job.sent}`,
      `err=${job.errors ?? job.failed}`,
      `msg=${job.status_message || ''}`,
      `eta_ms=${job.eta_ms ?? ''}`
    );
  }
  if (job.status !== 'running') {
    const out = {
      finished_at: new Date().toISOString(),
      elapsed_ms: Date.now() - t0,
      job: {
        jobId: job.jobId,
        status: job.status,
        dry_run: job.dry_run,
        scope: job.scope,
        phase: job.phase,
        status_message: job.status_message,
        started_at: job.started_at,
        finished_at: job.finished_at,
        error: job.error,
        result: job.result,
      },
    };
    fs.writeFileSync(outPath, JSON.stringify(out, null, 2));
    log('DONE', job.status, outPath);
    const r = job.result || {};
    log(
      'SUMMARY',
      JSON.stringify({
        incomplete_total: r.incomplete_total,
        incomplete_enriched: r.incomplete_enriched,
        incomplete_no_match: r.incomplete_no_match,
        incomplete_scanned: r.incomplete_scanned,
        incomplete_live_already_ok: r.incomplete_live_already_ok,
        incomplete_ambiguous: r.incomplete_ambiguous,
        incomplete_name_mismatch: r.incomplete_name_mismatch,
        incomplete_live_conflict: r.incomplete_live_conflict,
        deals_moved_perdido: r.deals_moved_perdido,
        dup_to_perdido: r.dup_to_perdido,
        dup_deals_moved_perdido: r.dup_deals_moved_perdido,
        dup_deal_groups: r.dup_deal_groups,
        created_deals: r.created_deals,
        skipped_already_has_deal_live: r.skipped_already_has_deal_live,
        orphan_no_match: r.orphan_no_match,
        errors: r.errors,
        deal_not_found: r.deal_not_found,
        cancelled: r.cancelled,
      })
    );
    process.exit(job.status === 'completed' ? 0 : 1);
  }
}

// silence unused import if tree-shaken — keep cancel helper available for ops note
void requestCancelOrphanAlunoProvision;
