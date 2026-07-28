/**
 * Apply rápido:
 * 1) provision órfãs alunas (cria deals)
 * 2) enrich só quem TEM deal e está incompleto
 */
import 'dotenv/config';
import fs from 'node:fs';

process.env.NOVO_CRM_PROVISION_ALLOW_PROD = '1';
// 250ms (era 60ms): 60ms tomava rajadas de 429 no CRM (2 chamadas/deal: createDeal + custom-fields).
process.env.NOVO_CRM_ORPHAN_PROVISION_DELAY_MS =
  process.env.NOVO_CRM_ORPHAN_PROVISION_DELAY_MS || '250';
process.env.NOVO_CRM_ENRICH_DELAY_MS = process.env.NOVO_CRM_ENRICH_DELAY_MS || '60';

const logPath = `data/apply-fast-${Date.now()}.log`;
function log(...args) {
  const line = `[${new Date().toISOString()}] ${args.map(String).join(' ')}`;
  console.log(line);
  fs.appendFileSync(logPath, line + '\n');
}

const { isNovoCrmWriteAllowedOnThisHost } = await import(
  '../server/services/novoCrmMatriculadosProvisionService.js'
);
const { startOrphanAlunoProvisionApplyBackground, getOrphanAlunoProvisionJob } = await import(
  '../server/services/novoCrmOrphanAlunoProvisionService.js'
);
const { getNovoCrmStageIds, getNovoCrmDealFieldIds } = await import(
  '../server/utils/novoCrmStageRules.js'
);

// Inline enrich only for rows with primary_deal_id — reuse enrichment internals via scope + filter
const enrichMod = await import('../server/services/novoCrmEnrichmentService.js');

log('CRM', process.env.NOVO_CRM_API_BASE_URL);
log('writeAllowed', isNovoCrmWriteAllowedOnThisHost());
if (!isNovoCrmWriteAllowedOnThisHost()) {
  log('ABORT');
  process.exit(1);
}

// Diagnóstico: confirma que os IDs resolvidos batem com PROD (data/novo-crm-prod-ids.json),
// não com o fallback hard-coded de DEV (cmrtilckh...) — ver bugfix 28/07/2026 em novoCrmStageRules.js.
const stageIds = getNovoCrmStageIds();
const fieldIds = getNovoCrmDealFieldIds();
log('stageIds', JSON.stringify(stageIds));
log('fieldIds', JSON.stringify(fieldIds));
const looksLikeDev = Object.values(stageIds).some((id) => id.startsWith('cmrtilckh'));
if (looksLikeDev) {
  log('ABORT stageIds look like DEV fallback, not PROD');
  process.exit(1);
}

log('STEP1 orphan provision START');
const orphanStart = startOrphanAlunoProvisionApplyBackground({ maxCreates: 20000 });
if (!orphanStart.started) {
  log('STEP1 ABORT', orphanStart.error);
  process.exit(1);
}
log('STEP1 jobId', orphanStart.jobId);
let orphan = null;
for (;;) {
  await new Promise((r) => setTimeout(r, 5000));
  const job = getOrphanAlunoProvisionJob(orphanStart.jobId);
  if (!job) break;
  log(
    `STEP1 orphan ${job.status} ${job.processed || 0}/${job.total || '?'} created=${job.sent || 0} fail=${job.failed || 0}`
  );
  if (job.status === 'completed' || job.status === 'failed') {
    orphan = job.result || { error: job.error };
    break;
  }
}
if (orphan) {
  const { samples, error_samples, ...orphanSummary } = orphan;
  log('STEP1 orphan DONE', JSON.stringify(orphanSummary));
  fs.writeFileSync(logPath.replace('.log', '-orphan.json'), JSON.stringify(orphan, null, 2));
  if (error_samples?.length) log('orphan errors', JSON.stringify(error_samples.slice(0, 20)));
} else {
  log('STEP1 orphan job disappeared without result');
}

log('STEP2 enrich with-deal START (background incomplete — post-provision cache may be stale; using cpf+rgm scopes on fresh DB)');

// After orphan creates deals in CRM, local cache still lacks primary_deal_id until next sync.
// Enrich for "already had deal" uses current cache. Run scopes cpf and rgm for rows that have deal.
const {
  startEnrichmentApplyBackground,
  getEnrichmentJob,
} = enrichMod;

async function runEnrichScope(scope) {
  log(`ENRICH ${scope} start`);
  const start = startEnrichmentApplyBackground({ scope });
  const jobId = start.jobId;
  log(`ENRICH ${scope} jobId`, jobId, start.started ? 'started' : start.error);
  for (;;) {
    await new Promise((r) => setTimeout(r, 5000));
    const job = getEnrichmentJob(jobId);
    if (!job) break;
    log(
      `ENRICH ${scope} ${job.status} ${job.processed || 0}/${job.total || '?'} sent=${job.sent || 0} fail=${job.failed || 0}`
    );
    if (job.status === 'completed' || job.status === 'failed') {
      log(`ENRICH ${scope} result`, JSON.stringify(job.result || { error: job.error }));
      return job.result || job;
    }
  }
  return null;
}

// Prioridade: quem já tinha deal e sem cpf/rgm (candidatos bem menores que incomplete 34k)
await runEnrichScope('cpf');
await runEnrichScope('rgm');

log('ALL DONE', logPath);
