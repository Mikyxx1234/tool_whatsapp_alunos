/**
 * Fast orphan-aluno provision on PROD.
 * Resumes past prior slow run via offset; no live-check (offset covers created).
 * Does NOT run enrich/flags/cache.
 */
import 'dotenv/config';
import fs from 'node:fs';

process.env.NOVO_CRM_PROVISION_ALLOW_PROD = '1';
process.env.NOVO_CRM_API_RATE_PER_SECOND = '6';
process.env.NOVO_CRM_ORPHAN_PROVISION_DELAY_MS = '0';
process.env.NOVO_CRM_ORPHAN_PROVISION_CONCURRENCY = '2';
// LIVE_CHECK=1 (default): evita recriar deal em órfão que já ganhou deal.
// NÃO desligar em PROD — incidente 28/07 (spam no sibling com cache stale).
process.env.NOVO_CRM_ORPHAN_LIVE_CHECK = process.env.NOVO_CRM_ORPHAN_LIVE_CHECK || '1';
// SKIP_FIELDS=1 ainda grava CPF+RGM (dedupe). Default OFF — preenche situacao/stage fields.
process.env.NOVO_CRM_ORPHAN_SKIP_FIELDS = process.env.NOVO_CRM_ORPHAN_SKIP_FIELDS || '0';
process.env.NOVO_CRM_ORPHAN_OFFSET = process.env.NOVO_CRM_ORPHAN_OFFSET || '0';

const logPath = `data/orphan-apply-${Date.now()}.log`;
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
} = await import('../server/services/novoCrmOrphanAlunoProvisionService.js');

const stageIds = getNovoCrmStageIds();
log('FAST_ORPHAN CRM', process.env.NOVO_CRM_API_BASE_URL);
log('writeAllowed', isNovoCrmWriteAllowedOnThisHost());
log('stageIds.Graduação', stageIds['Graduação'] || stageIds.Graduação);
log(
  'rate',
  process.env.NOVO_CRM_API_RATE_PER_SECOND,
  'delay',
  process.env.NOVO_CRM_ORPHAN_PROVISION_DELAY_MS,
  'conc',
  process.env.NOVO_CRM_ORPHAN_PROVISION_CONCURRENCY,
  'offset',
  process.env.NOVO_CRM_ORPHAN_OFFSET,
  'liveCheck',
  process.env.NOVO_CRM_ORPHAN_LIVE_CHECK,
  'skipFields',
  process.env.NOVO_CRM_ORPHAN_SKIP_FIELDS
);
if (!isNovoCrmWriteAllowedOnThisHost()) {
  log('ABORT write gate');
  process.exit(1);
}
if (!String(stageIds['Graduação'] || '').startsWith('cmrwd5vun')) {
  log('ABORT unexpected Graduação stage id', stageIds['Graduação']);
  process.exit(1);
}

const maxCreates = Number(process.env.ORPHAN_MAX || 20000) || 20000;
log('ORPHAN START maxCreates=', maxCreates);

const start = startOrphanAlunoProvisionApplyBackground({ maxCreates });
if (!start.started) {
  log('ABORT already running', start.jobId, start.error);
  process.exit(1);
}
log('jobId', start.jobId);

const t0 = Date.now();
for (;;) {
  await new Promise((r) => setTimeout(r, 20000));
  const job = getOrphanAlunoProvisionJob(start.jobId);
  if (!job) {
    log('ABORT job disappeared');
    process.exit(1);
  }
  const elapsedMin = ((Date.now() - t0) / 60000).toFixed(1);
  const created = job.sent || 0;
  const rate = elapsedMin > 0 ? (created / (Number(elapsedMin) * 60)).toFixed(2) : '0';
  log(
    `PROGRESS status=${job.status} phase=${job.phase} scanned=${job.processed || 0}/${job.total || '?'} created_deals=${created} errors=${job.failed || 0} rate_per_s=${rate} elapsed_min=${elapsedMin}`
  );
  if (job.status === 'completed' || job.status === 'failed') {
    const result = job.result || { error: job.error };
    const { samples, error_samples, ...summary } = result;
    log('ORPHAN DONE', JSON.stringify(summary));
    if (error_samples?.length) {
      log('error_samples', JSON.stringify(error_samples.slice(0, 15)));
    }
    fs.writeFileSync(logPath.replace('.log', '-full.json'), JSON.stringify(result, null, 2));
    log('ALL DONE', logPath);
    // Prior run ~413 + this run created. Note prior separately.
    log('NOTE prior_slow_run_created_approx=413');
    process.exit(job.status === 'failed' ? 1 : 0);
  }
}
