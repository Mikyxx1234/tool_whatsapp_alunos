/**
 * Provisiona matriculados → CRM DEV (cria contatos+negócios classificados).
 * Força URL DEV; token só via env (NOVO_CRM_DEV_API_TOKEN / NOVO_CRM_API_TOKEN).
 *
 * Uso:
 *   node --env-file=.env scripts/novo-crm-provision-run.mjs [maxCreates] [--dry] [--offset=N]
 *   ex.: node --env-file=.env scripts/novo-crm-provision-run.mjs 1000
 *        node --env-file=.env scripts/novo-crm-provision-run.mjs 25 --dry
 *        node --env-file=.env scripts/novo-crm-provision-run.mjs 2000 --offset=1004
 */

import { forceNovoCrmDevEnv } from './_novoCrmDevEnv.mjs';

const { base } = forceNovoCrmDevEnv();
process.env.NOVO_CRM_CACHE_SOURCE = process.env.NOVO_CRM_CACHE_SOURCE || 'api';
process.env.NOVO_CRM_PROVISION_ENABLED = '1';
process.env.NOVO_CRM_PROVISION_DELAY_MS = process.env.NOVO_CRM_PROVISION_DELAY_MS || '1500';

const args = process.argv.slice(2);
const dryRun = args.includes('--dry');
const maxCreates = Math.min(Math.max(Number(args.find((a) => /^\d+$/.test(a))) || 1000, 1), 20000);
const offsetArg = args.find((a) => /^--offset=\d+$/.test(a));
const offset = offsetArg ? Number(offsetArg.split('=')[1]) : 0;

const { runMatriculadosProvision } = await import(
  '../server/services/novoCrmMatriculadosProvisionService.js'
);

console.log(`[provision-run] base=${base} dry=${dryRun} max=${maxCreates} offset=${offset}`);
const result = await runMatriculadosProvision({ dryRun, maxCreates, offset });
console.log('[provision-run] resultado:', JSON.stringify(result, null, 2));
process.exit(result?.ok ? 0 : 1);
