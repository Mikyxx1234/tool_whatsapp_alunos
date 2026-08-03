/**
 * Att de campos only (mode=fields) — PROD, ritmo acelerado.
 * Uso: node scripts/novo-crm-fields-apply-fast.mjs
 */
import fs from 'node:fs';
import path from 'node:path';

import 'dotenv/config';

process.env.NOVO_CRM_PROVISION_ALLOW_PROD = '1';
process.env.NOVO_CRM_API_RATE_PER_SECOND =
  process.env.NOVO_CRM_FIELDS_RATE || process.env.NOVO_CRM_API_RATE_PER_SECOND || '8';
process.env.NOVO_CRM_FLAGS_SYNC_MAX_ERRORS =
  process.env.NOVO_CRM_FLAGS_SYNC_MAX_ERRORS || '500';

const logPath = path.join(
  'data',
  `fields-apply-${Date.now()}.log`
);
fs.mkdirSync('data', { recursive: true });
function log(...args) {
  const line = `[${new Date().toISOString()}] ${args.map(String).join(' ')}`;
  console.log(line);
  fs.appendFileSync(logPath, line + '\n');
}

const { isNovoCrmWriteAllowedOnThisHost } = await import(
  '../server/services/novoCrmMatriculadosProvisionService.js'
);
const { runFlagsStageSync } = await import(
  '../server/services/novoCrmFlagsStageSyncService.js'
);

log('CRM', process.env.NOVO_CRM_API_BASE_URL);
log('rate', process.env.NOVO_CRM_API_RATE_PER_SECOND);
log('writeAllowed', isNovoCrmWriteAllowedOnThisHost());
log('maxErrors', process.env.NOVO_CRM_FLAGS_SYNC_MAX_ERRORS);

if (!isNovoCrmWriteAllowedOnThisHost()) {
  log('ABORT write not allowed');
  process.exit(1);
}

log('FIELDS apply START mode=fields');
const started = Date.now();

// Progress heartbeat via wrapping — runFlagsStageSync logs every 100 internally via patchJob only.
// Periodic status: poll isn't available without jobId; rely on console from service + final result.
const result = await runFlagsStageSync({
  dryRun: false,
  mode: 'fields',
  maxDeals: 100000,
});

const mins = ((Date.now() - started) / 60000).toFixed(1);
const { samples, error_samples, ...summary } = result || {};
log('FIELDS apply DONE mins=', mins, JSON.stringify(summary));
fs.writeFileSync(logPath.replace('.log', '-summary.json'), JSON.stringify(result, null, 2));
log('log', logPath);
if (result?.aborted) process.exit(2);
