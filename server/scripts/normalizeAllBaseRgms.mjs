/**
 * Normaliza RGMs em todas as tabelas *_rows para o modelo oficial (8 dígitos).
 * Uso: node server/scripts/normalizeAllBaseRgms.mjs
 */
import 'dotenv/config';
import { query } from '../db/client.js';
import { isRgmColumnKey, normalizeRgmCanonical, normalizeRowRgms } from '../utils/rgmDisplay.js';
import { invalidateActivationListCache } from '../services/activationService.js';
import { invalidateComparisonCache } from '../services/baseComparisonService.js';
import { invalidateOverviewCache } from '../services/reportOverviewCache.js';

const BATCH = 500;

const TABLES = [
  { table: 'matriculados_rows', category: 'matriculados' },
  { table: 'docs_pendentes_rows', category: 'docs-pendentes' },
  { table: 'financeiro_rows', category: 'financeiro' },
  { table: 'acessos_blackboard_rows', category: 'acessos-blackboard' },
  { table: 'processos_caa_rows', category: 'processos-caa' },
  { table: 'provavel_evasao_rows', category: 'provavel-evasao' },
];

/**
 * @param {Record<string, unknown>} data
 */
function rowNeedsRgmFix(data) {
  if (!data || typeof data !== 'object') return false;
  for (const [key, val] of Object.entries(data)) {
    if (!isRgmColumnKey(key)) continue;
    const raw = String(val ?? '').trim();
    if (!raw) continue;
    const canon = normalizeRgmCanonical(val);
    if (canon && canon !== raw) return true;
    if (!canon && raw) return true;
  }
  return false;
}

/**
 * @param {string} table
 * @param {{ id: string, data: Record<string, unknown> }[]} chunk
 */
async function flushBatch(table, chunk) {
  if (!chunk.length) return;
  const ids = chunk.map((r) => r.id);
  const payloads = chunk.map((r) => JSON.stringify(normalizeRowRgms(r.data)));
  await query(
    `update ${table} as t
     set data = v.data::jsonb
     from unnest($1::uuid[], $2::text[]) as v(id, data)
     where t.id = v.id`,
    [ids, payloads]
  );
}

for (const { table, category } of TABLES) {
  const { rows } = await query(`select id, data from ${table}`);
  let updated = 0;
  /** @type {{ id: string, data: Record<string, unknown> }[]} */
  let pending = [];

  for (const r of rows) {
    const data = r.data;
    if (!data || typeof data !== 'object' || !rowNeedsRgmFix(data)) continue;
    pending.push({ id: r.id, data });
    if (pending.length >= BATCH) {
      await flushBatch(table, pending);
      updated += pending.length;
      pending = [];
      process.stdout.write(`  ${table}: ${updated}...\r`);
    }
  }
  if (pending.length) {
    await flushBatch(table, pending);
    updated += pending.length;
  }

  console.log(`${table}: ${updated}/${rows.length} linhas atualizadas`);
}

invalidateComparisonCache();
invalidateOverviewCache();
for (const { category } of TABLES) {
  invalidateActivationListCache(category);
}
invalidateActivationListCache();

console.log('Caches invalidados.');
process.exit(0);
