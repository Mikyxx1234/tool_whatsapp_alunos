/**
 * Reset do cache Novo CRM para o ambiente DEV.
 *
 * O QUE FAZ:
 *   1. TRUNCATE em novo_crm_person_cache (apaga o espelho local — NÃO toca no CRM real).
 *   2. Full sync a partir do CRM DEV (repopula o cache limpo).
 *
 * SEGURANÇA:
 *   - Só mexe no cache LOCAL (banco `disparos`). Nenhuma escrita no CRM.
 *   - Força as credenciais de DEV no processo, independente do que estiver no .env,
 *     pra evitar repopular produção por acidente.
 *
 * USO:
 *   node --env-file=.env scripts/novo-crm-reset-dev.mjs
 *   (o .env só precisa fornecer DATABASE_URL; as credenciais do CRM são forçadas p/ DEV abaixo)
 */

// --- Força ambiente DEV (não depende do .env) ---
process.env.NOVO_CRM_ENABLED = '1';
process.env.NOVO_CRM_CACHE_ENABLED = '1';
process.env.NOVO_CRM_CACHE_SOURCE = 'api';
process.env.NOVO_CRM_API_BASE_URL = 'https://crm-dev-frontend.ca31ey.easypanel.host';
process.env.NOVO_CRM_API_TOKEN = 'eduit_2647db702aef5fcf2a3eacef869e0b35b985d5a20b60a5e5';
process.env.NOVO_CRM_CACHE_FETCH_DEAL_FIELDS =
  process.env.NOVO_CRM_CACHE_FETCH_DEAL_FIELDS || '1';
process.env.NOVO_CRM_API_RATE_PER_SECOND = process.env.NOVO_CRM_API_RATE_PER_SECOND || '4';

// Trava dura: se por engano a base apontar pra produção, aborta.
const base = String(process.env.NOVO_CRM_API_BASE_URL || '');
if (base.includes('crm.eduit.com.br')) {
  console.error('[reset-dev] ABORTADO: base aponta pra PRODUÇÃO. Este script é DEV-only.');
  process.exit(2);
}

const pg = (await import('pg')).default;
const { runNovoCrmCacheSync } = await import(
  '../server/services/novoCrmPersonCacheSyncService.js'
);

const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
await client.connect();

const before = await client.query('select count(*)::int n from novo_crm_person_cache');
console.log(`[reset-dev] cache antes: ${before.rows[0].n} linhas`);
console.log(`[reset-dev] base DEV: ${base}`);

console.log('[reset-dev] TRUNCATE novo_crm_person_cache ...');
await client.query('TRUNCATE TABLE novo_crm_person_cache');

const after = await client.query('select count(*)::int n from novo_crm_person_cache');
console.log(`[reset-dev] cache após truncate: ${after.rows[0].n} linhas`);
await client.end();

console.log('[reset-dev] iniciando FULL sync do DEV (pode levar ~30-40 min com deal fields)...');
const result = await runNovoCrmCacheSync({ mode: 'full' });
console.log('[reset-dev] resultado:', JSON.stringify(result, null, 2));

process.exit(result?.ok ? 0 : 1);
