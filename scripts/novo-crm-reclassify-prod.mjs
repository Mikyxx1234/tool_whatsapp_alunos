/**
 * Reclassifica deals existentes no CRM (ex.: Lead de Entrada → fase certa)
 * via runFlagsStageSync + IDs de data/novo-crm-prod-ids.json.
 *
 * Uso:
 *   node --env-file=.env scripts/novo-crm-reclassify-prod.mjs --dry --max=500
 *   node --env-file=.env scripts/novo-crm-reclassify-prod.mjs --apply --max=50000
 *
 * Exige NOVO_CRM_PROVISION_ALLOW_PROD=1 no apply (setado pelo script só se --apply).
 */

import { applyNovoCrmProdIdsFromFile } from './_applyNovoCrmProdIds.mjs';

const args = process.argv.slice(2);
const dry = args.includes('--dry') || !args.includes('--apply');
const apply = args.includes('--apply');
const maxArg = args.find((a) => a.startsWith('--max='));
const maxDeals = Math.min(Math.max(Number(maxArg?.split('=')[1]) || (dry ? 2000 : 50000), 1), 100000);

process.env.NOVO_CRM_ENABLED = '1';
process.env.NOVO_CRM_CACHE_SOURCE = process.env.NOVO_CRM_CACHE_SOURCE || 'api';

const ids = applyNovoCrmProdIdsFromFile();
const base = String(process.env.NOVO_CRM_API_BASE_URL || '').trim();
if (!base) {
  console.error('[reclassify] NOVO_CRM_API_BASE_URL obrigatório');
  process.exit(2);
}
if (base.includes('crm-dev')) {
  console.error('[reclassify] BASE parece DEV. Este script é para PROD (crm.eduit / import).');
  process.exit(2);
}

if (apply) {
  process.env.NOVO_CRM_PROVISION_ALLOW_PROD = '1';
  process.env.NOVO_CRM_FLAGS_SYNC_ENABLED = '1';
} else {
  // dry-run ainda precisa passar host guard
  process.env.NOVO_CRM_PROVISION_ALLOW_PROD = '1';
}

// Calm rate + error budget (404 missing deals são skip, não contam).
if (!process.env.NOVO_CRM_API_RATE_PER_SECOND) {
  process.env.NOVO_CRM_API_RATE_PER_SECOND = '5';
}
if (!process.env.NOVO_CRM_FLAGS_SYNC_MAX_ERRORS) {
  process.env.NOVO_CRM_FLAGS_SYNC_MAX_ERRORS = '500';
}

console.log(
  `[reclassify] base=${base} dry=${!apply} max=${maxDeals} pipeline=${ids.pipeline?.name || '?'}`
);
console.log(
  `[reclassify] stages carregados: ${Object.keys(ids.stages || {}).length} fields: ${Object.keys(ids.fields || {}).length}`
);

const { runFlagsStageSync } = await import('../server/services/novoCrmFlagsStageSyncService.js');

const result = await runFlagsStageSync({
  dryRun: !apply,
  mode: 'flags_stage',
  maxDeals,
});

console.log('[reclassify] resultado:', JSON.stringify(result, null, 2));
process.exit(result?.ok ? 0 : 1);
