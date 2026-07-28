/**
 * Full sync do espelho local (novo_crm_person_cache) a partir da API do .env.
 * Para reclassify PROD: .env deve apontar pra crm.eduit.com.br.
 *
 * Uso:
 *   node --env-file=.env scripts/novo-crm-cache-full-sync.mjs
 *   node --env-file=.env scripts/novo-crm-cache-full-sync.mjs --truncate
 */

const truncate = process.argv.includes('--truncate');

process.env.NOVO_CRM_ENABLED = '1';
process.env.NOVO_CRM_CACHE_ENABLED = '1';
process.env.NOVO_CRM_CACHE_SOURCE = 'api';
process.env.NOVO_CRM_CACHE_FETCH_DEAL_FIELDS =
  process.env.NOVO_CRM_CACHE_FETCH_DEAL_FIELDS || '1';
process.env.NOVO_CRM_API_RATE_PER_SECOND = process.env.NOVO_CRM_API_RATE_PER_SECOND || '4';

const base = String(process.env.NOVO_CRM_API_BASE_URL || '').trim();
if (!base) {
  console.error('[cache-full] NOVO_CRM_API_BASE_URL obrigatório');
  process.exit(2);
}
console.log(`[cache-full] base=${base} truncate=${truncate} fetchDealFields=${process.env.NOVO_CRM_CACHE_FETCH_DEAL_FIELDS}`);

if (truncate) {
  const pg = (await import('pg')).default;
  const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();
  const before = await client.query('select count(*)::int n from novo_crm_person_cache');
  console.log(`[cache-full] cache antes: ${before.rows[0].n}`);
  await client.query('TRUNCATE TABLE novo_crm_person_cache');
  console.log('[cache-full] TRUNCATE ok');
  await client.end();
}

const { runNovoCrmCacheSync } = await import(
  '../server/services/novoCrmPersonCacheSyncService.js'
);

const result = await runNovoCrmCacheSync({ mode: 'full' });
console.log('[cache-full] resultado:', JSON.stringify(result, null, 2));
process.exit(result?.ok ? 0 : 1);
