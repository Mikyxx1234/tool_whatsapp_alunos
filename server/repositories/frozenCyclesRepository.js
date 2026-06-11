import { query } from '../db/client.js';

const CACHE_TTL_MS = 5 * 60 * 1000;

/** @type {{ expires: number, set: Set<string> } | null} */
let frozenSetCache = null;

export function bustFrozenSetCache() {
  frozenSetCache = null;
}

/**
 * @returns {Promise<Array<{ciclo: string, frozen_at: Date, frozen_by: string|null, reason: string|null}>>}
 */
export async function listFrozen() {
  const { rows } = await query(
    `select ciclo, frozen_at, frozen_by, reason
       from frozen_cycles
      order by frozen_at desc`
  );
  return rows;
}

/**
 * Conjunto de ciclos frozen (uso interno em filtros). Cache 5min.
 * @returns {Promise<Set<string>>}
 */
export async function getFrozenSet() {
  if (frozenSetCache && frozenSetCache.expires > Date.now()) {
    return frozenSetCache.set;
  }
  const { rows } = await query(`select ciclo from frozen_cycles`);
  const set = new Set(rows.map((r) => r.ciclo));
  frozenSetCache = { expires: Date.now() + CACHE_TTL_MS, set };
  return set;
}

/**
 * @param {string} ciclo
 * @param {{ reason?: string|null, by?: string|null }} [opts]
 */
export async function freezeCycle(ciclo, { reason = null, by = null } = {}) {
  const c = String(ciclo || '').trim();
  if (!c) {
    const err = new Error('ciclo é obrigatório');
    err.status = 400;
    throw err;
  }
  await query(
    `insert into frozen_cycles (ciclo, reason, frozen_by)
     values ($1, $2, $3)
     on conflict (ciclo) do update set
       reason    = excluded.reason,
       frozen_by = excluded.frozen_by,
       frozen_at = now()`,
    [c, reason, by]
  );
  bustFrozenSetCache();
}

/**
 * @param {string} ciclo
 * @returns {Promise<boolean>} true se deletou, false se não existia
 */
export async function unfreezeCycle(ciclo) {
  const c = String(ciclo || '').trim();
  if (!c) return false;
  const { rowCount } = await query(`delete from frozen_cycles where ciclo = $1`, [c]);
  bustFrozenSetCache();
  return rowCount > 0;
}
