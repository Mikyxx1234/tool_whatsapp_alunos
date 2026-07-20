/**
 * Sync amostral do cache Novo CRM (ex.: 10%) — sem markDeleted.
 * Uso: node --env-file=.env scripts/novo-crm-sample-sync.mjs [samplePct]
 */
import { runNovoCrmCacheSync } from '../server/services/novoCrmPersonCacheSyncService.js';

const samplePct = Number(process.argv[2] || process.env.NOVO_CRM_SAMPLE_PCT || 10);

console.log(`[novo-crm-sample-sync] iniciando full sample_pct=${samplePct}`);
const result = await runNovoCrmCacheSync({ mode: 'full', samplePct });
console.log('[novo-crm-sample-sync] resultado:', JSON.stringify(result, null, 2));
process.exit(result?.ok ? 0 : 1);
