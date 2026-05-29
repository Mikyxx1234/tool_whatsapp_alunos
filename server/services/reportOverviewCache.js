/** Cache em memória do resumo dos cards (evita COUNT pesado a cada refresh). */

const TTL_MS = Number(process.env.REPORT_OVERVIEW_CACHE_TTL_MS) || 5 * 60 * 1000;

/** @type {{ at: number, data: { counts: Record<string, number>, count_hints?: Record<string, string> } } | null} */
let cache = null;

export function invalidateOverviewCache() {
  cache = null;
}

/**
 * @param {() => Promise<{ counts: Record<string, number>, count_hints?: Record<string, string> }>} factory
 */
export async function getCachedOverview(factory) {
  if (cache && Date.now() - cache.at < TTL_MS) {
    return cache.data;
  }
  const data = await factory();
  cache = { at: Date.now(), data };
  return data;
}
