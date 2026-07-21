/**
 * Provisiona matriculados → CRM DEV (cria contatos+negócios classificados).
 * Força credenciais DEV; aborta se detectar produção.
 *
 * Uso:
 *   node --env-file=.env scripts/novo-crm-provision-run.mjs [maxCreates] [--dry]
 *   ex.: node --env-file=.env scripts/novo-crm-provision-run.mjs 1000
 *        node --env-file=.env scripts/novo-crm-provision-run.mjs 25 --dry
 */

process.env.NOVO_CRM_ENABLED = '1';
process.env.NOVO_CRM_CACHE_SOURCE = 'api';
process.env.NOVO_CRM_API_BASE_URL = 'https://crm-dev-frontend.ca31ey.easypanel.host';
process.env.NOVO_CRM_API_TOKEN = 'eduit_2647db702aef5fcf2a3eacef869e0b35b985d5a20b60a5e5';
process.env.NOVO_CRM_PROVISION_ENABLED = '1';
process.env.NOVO_CRM_PROVISION_DELAY_MS = process.env.NOVO_CRM_PROVISION_DELAY_MS || '1500';

const base = String(process.env.NOVO_CRM_API_BASE_URL || '');
if (base.includes('crm.eduit.com.br')) {
  console.error('[provision-run] ABORTADO: base aponta pra PRODUÇÃO. DEV-only.');
  process.exit(2);
}

const args = process.argv.slice(2);
const dryRun = args.includes('--dry');
const maxCreates = Math.min(Math.max(Number(args.find((a) => /^\d+$/.test(a))) || 1000, 1), 1000);

const { runMatriculadosProvision } = await import(
  '../server/services/novoCrmMatriculadosProvisionService.js'
);

console.log(`[provision-run] base=${base} dry=${dryRun} max=${maxCreates}`);
const result = await runMatriculadosProvision({ dryRun, maxCreates });
console.log('[provision-run] resultado:', JSON.stringify(result, null, 2));
process.exit(result?.ok ? 0 : 1);
