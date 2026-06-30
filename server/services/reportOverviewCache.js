/** Cache em memória do resumo dos cards (evita COUNT pesado a cada refresh). */

const TTL_MS = Number(process.env.REPORT_OVERVIEW_CACHE_TTL_MS) || 5 * 60 * 1000;

/** @type {Map<string, { at: number, data: { counts: Record<string, number>, count_hints?: Record<string, string> } }>} */
const caches = new Map();

export function invalidateOverviewCache() {
  caches.clear();
}

/**
 * @param {() => Promise<{ counts: Record<string, number>, count_hints?: Record<string, string> }>} factory
 * @param {string} [cacheKey] chave vazia = visão global (sem filtro)
 */
export async function getCachedOverview(factory, cacheKey = '') {
  const key = cacheKey || '__all__';
  const hit = caches.get(key);
  if (hit && Date.now() - hit.at < TTL_MS) {
    return hit.data;
  }
  const data = await factory();
  caches.set(key, { at: Date.now(), data });
  return data;
}
