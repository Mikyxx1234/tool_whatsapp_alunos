/**
 * Estima tempo do preflight bulk_search (sem bater na API).
 * Uso: node server/scripts/estimateActivationPreflight.mjs [N]
 */
const N = Math.max(Number(process.argv[2]) || 100, 1);

const mode = String(process.env.DATACRAZY_ACTIVATION_LOOKUP_MODE ?? 'bulk_search').toLowerCase();
const threshold = Number(process.env.DATACRAZY_DIRECT_SEARCH_THRESHOLD) || 5000;
const concurrency = Number(process.env.DATACRAZY_DIRECT_SEARCH_CONCURRENCY) || 10;
const crmRate = Number(process.env.DATACRAZY_CRM_RATE_PER_SECOND) || 15;
const batchConcurrency = Number(process.env.ACTIVATION_BATCH_CONCURRENCY) || 10;

const useDirect = N <= threshold;
// ~2 termos/pessoa em média (2 passadas), cache hit reduz na prática
const searchQueries = useDirect ? Math.ceil((N * 1.5) / concurrency) * concurrency : 500;
const preflightSec = useDirect ? Math.ceil(searchQueries / crmRate) : 120;
const sendSec = Math.ceil(N / batchConcurrency) * 2; // ~2s/lead com origem+whatsapp

console.log('--- Config efetiva (env ou default) ---');
console.log(`DATACRAZY_ACTIVATION_LOOKUP_MODE: ${mode}`);
console.log(`DIRECT_SEARCH_THRESHOLD: ${threshold}`);
console.log(`DIRECT_SEARCH_CONCURRENCY: ${concurrency}`);
console.log(`CRM_RATE_PER_SECOND: ${crmRate}`);
console.log(`ACTIVATION_BATCH_CONCURRENCY: ${batchConcurrency}`);

console.log(`\n--- Estimativa para ${N} leads ---`);
if (mode === 'cache_first') {
  const serialSec = Math.ceil(N / crmRate) + N * 0.5;
  console.log(`Modo cache_first: ~${Math.ceil(serialSec / 60)} min (serial API por lead)`);
  console.log('Recomendação: usar bulk_search (default) ou remover env cache_first no Easypanel.');
} else if (useDirect) {
  console.log(`Preflight bulk_search (busca direta): ~${preflightSec}s`);
  console.log(`Envio (${batchConcurrency} paralelos): ~${sendSec}s`);
  console.log(`Total aproximado: ~${Math.ceil((preflightSec + sendSec) / 60)} min`);
} else {
  console.log('Preflight cairia em paginação CRM (> threshold) — pode levar vários minutos.');
}

process.exit(0);
