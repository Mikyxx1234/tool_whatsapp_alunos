/**
 * Aplica enrich (alunos com deal) + provision órfãs alunas no CRM PROD.
 * NOVO_CRM_PROVISION_ALLOW_PROD=1 é setado nesta execução.
 */
import 'dotenv/config';
import fs from 'node:fs';

process.env.NOVO_CRM_PROVISION_ALLOW_PROD = '1';
process.env.NOVO_CRM_ORPHAN_PROVISION_DELAY_MS =
  process.env.NOVO_CRM_ORPHAN_PROVISION_DELAY_MS || '80';
process.env.NOVO_CRM_ENRICH_DELAY_MS = process.env.NOVO_CRM_ENRICH_DELAY_MS || '80';

const logPath = `data/apply-enrich-orphan-${Date.now()}.log`;
function log(...args) {
  const line = `[${new Date().toISOString()}] ${args.map(String).join(' ')}`;
  console.log(line);
  fs.appendFileSync(logPath, line + '\n');
}

const { isNovoCrmWriteAllowedOnThisHost } = await import(
  '../server/services/novoCrmMatriculadosProvisionService.js'
);
const {
  startEnrichmentApplyBackground,
  getEnrichmentJob,
} = await import('../server/services/novoCrmEnrichmentService.js');
const { runOrphanAlunoProvision } = await import(
  '../server/services/novoCrmOrphanAlunoProvisionService.js'
);

log('CRM', process.env.NOVO_CRM_API_BASE_URL);
log('writeAllowed', isNovoCrmWriteAllowedOnThisHost());
if (!isNovoCrmWriteAllowedOnThisHost()) {
  log('ABORT: escrita bloqueada');
  process.exit(1);
}

// --- 1) Enrich incomplete (só quem já tem deal + match aluno) ---
log('ENRICH start scope=incomplete');
const enrichStart = startEnrichmentApplyBackground({ scope: 'incomplete' });
if (!enrichStart.started) {
  log('ENRICH already running', enrichStart.jobId, enrichStart.error);
}
const enrichJobId = enrichStart.jobId;
log('ENRICH jobId', enrichJobId);

for (;;) {
  await new Promise((r) => setTimeout(r, 5000));
  const job = getEnrichmentJob(enrichJobId);
  if (!job) {
    log('ENRICH job disappeared');
    break;
  }
  log(
    `ENRICH ${job.status} phase=${job.phase} ${job.processed || 0}/${job.total || '?'} sent=${job.sent || 0} fail=${job.failed || 0}`
  );
  if (job.status === 'completed' || job.status === 'failed') {
    log('ENRICH result', JSON.stringify(job.result || { error: job.error }));
    break;
  }
}

// --- 2) Orphan provision (cria deals) ---
log('ORPHAN provision start');
const orphan = await runOrphanAlunoProvision({ dryRun: false, maxCreates: 20000 });
const { samples, error_samples, ...summary } = orphan;
log('ORPHAN result', JSON.stringify(summary));
if (error_samples?.length) {
  log('ORPHAN errors', JSON.stringify(error_samples.slice(0, 15)));
}
fs.writeFileSync(
  logPath.replace('.log', '-orphan.json'),
  JSON.stringify(orphan, null, 2)
);
log('ALL DONE →', logPath);
