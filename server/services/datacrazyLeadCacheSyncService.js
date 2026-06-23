/**
 * Sync completo do cache local cpf → datacrazy_lead_id.
 *
 * Varre todas as páginas de leads no DataCrazy e popula
 * `datacrazy_lead_cache`. Reduz disparos de 10k leads de ~17min pra <5s
 * quando o cache estiver quente.
 *
 * Dois caminhos de execução (redundância intencional):
 *   1. POST /api/maintenance/sync-datacrazy-cache (endpoint manual)
 *   2. Cron diário às DATACRAZY_CACHE_SYNC_HOUR_UTC (default 03:00 UTC)
 */
import { datacrazyClient } from './datacrazyClient.js';
import * as datacrazyLeadCacheRepo from '../repositories/datacrazyLeadCacheRepository.js';

/**
 * Varre todas as páginas da API DataCrazy e popula o cache.
 *
 * @param {{ dryRun?: boolean }} [opts]
 * @returns {Promise<{
 *   logId: string,
 *   pages: number,
 *   leadsSeen: number,
 *   upserted: number,
 *   skipped: number,
 *   durationMs: number,
 *   dry_run: boolean,
 * }>}
 */
export async function runFullSync({ dryRun = false } = {}) {
  const take = Math.min(
    Math.max(
      Number(process.env.DATACRAZY_CACHE_SYNC_PAGE_SIZE) ||
        Number(process.env.DATACRAZY_LEADS_PAGE_SIZE) ||
        200,
      1
    ),
    500
  );
  const maxPages = Math.max(
    Number(process.env.DATACRAZY_CACHE_SYNC_MAX_PAGES) || 2000,
    1
  );
  const pageDelay = Math.max(
    Number(process.env.DATACRAZY_CACHE_SYNC_PAGE_DELAY_MS) ||
      Number(process.env.DATACRAZY_PAGE_DELAY_MS) ||
      200,
    0
  );

  const logId = await datacrazyLeadCacheRepo.recordSyncStart();
  const startMs = Date.now();

  let pages = 0;
  let leadsSeen = 0;
  let upserted = 0;
  let skipped = 0;
  let skip = 0;

  function sleep(ms) {
    return new Promise((r) => setTimeout(r, ms));
  }

  try {
    while (pages < maxPages) {
      const page = await datacrazyClient.searchLeads({
        take,
        skip,
        completeAdditionalFields: false,
      });
      pages += 1;
      const batch = Array.isArray(page.data) ? page.data : [];
      if (!batch.length) break;

      leadsSeen += batch.length;

      if (!dryRun) {
        const toUpsert = [];
        for (const lead of batch) {
          const cpf = String(lead?.taxId ?? '').replace(/\D/g, '');
          if (cpf.length !== 11) {
            skipped += 1;
            continue;
          }
          toUpsert.push(lead);
        }
        if (toUpsert.length > 0) {
          const n = await datacrazyLeadCacheRepo.upsertLeadFromCrmBatch(toUpsert, 'sync');
          upserted += n;
        }
      } else {
        // dryRun: conta apenas, não persiste
        for (const lead of batch) {
          const cpf = String(lead?.taxId ?? '').replace(/\D/g, '');
          if (cpf.length !== 11) skipped += 1;
          else upserted += 1;
        }
      }

      if (batch.length < take) break;
      if (page.count != null && skip + batch.length >= page.count) break;
      skip += batch.length;
      if (pageDelay > 0) await sleep(pageDelay);
    }

    const durationMs = Date.now() - startMs;
    await datacrazyLeadCacheRepo.recordSyncFinish(logId, {
      pages,
      leadsSeen,
      upserted,
      skipped,
      status: 'ok',
    });
    console.log(
      `[datacrazy-cache-sync] ok pages=${pages} seen=${leadsSeen} upserted=${upserted} skipped=${skipped} ${durationMs}ms dry=${dryRun}`
    );
    return { logId, pages, leadsSeen, upserted, skipped, durationMs, dry_run: dryRun };
  } catch (err) {
    const durationMs = Date.now() - startMs;
    console.error('[datacrazy-cache-sync] FAIL:', err.message);
    await datacrazyLeadCacheRepo
      .recordSyncFinish(logId, {
        pages,
        leadsSeen,
        upserted,
        skipped,
        status: 'error',
        errorMessage: err.message,
      })
      .catch(() => {});
    throw err;
  }
}

/**
 * Inicia o cron diário de sync do cache DataCrazy.
 * Respeita DATACRAZY_CACHE_ENABLED (default '1'; '0' = desabilitado).
 * Hora configurada em DATACRAZY_CACHE_SYNC_HOUR_UTC (0–23 UTC, default 3).
 */
export function startDatacrazyCacheSyncCron() {
  if (String(process.env.DATACRAZY_CACHE_ENABLED ?? '1') === '0') {
    console.log(
      '[datacrazy-cache-sync] Cache desabilitado (DATACRAZY_CACHE_ENABLED=0). Cron não iniciado.'
    );
    return;
  }

  const hourUtc = Math.max(
    0,
    Math.min(23, Math.floor(Number(process.env.DATACRAZY_CACHE_SYNC_HOUR_UTC) || 3))
  );

  function msUntilNextRun() {
    const now = new Date();
    const next = new Date(now);
    next.setUTCHours(hourUtc, 0, 0, 0);
    if (next <= now) next.setUTCDate(next.getUTCDate() + 1);
    return next.getTime() - now.getTime();
  }

  const doSync = () => {
    runFullSync().catch((err) =>
      console.error('[datacrazy-cache-sync] cron FAIL:', err.message)
    );
  };

  const delay = msUntilNextRun();
  console.log(
    `[datacrazy-cache-sync] Próxima sync em ${Math.round(delay / 60000)} min (${String(hourUtc).padStart(2, '0')}:00 UTC).`
  );

  const t = setTimeout(() => {
    doSync();
    const interval = setInterval(doSync, 24 * 60 * 60 * 1000);
    if (typeof interval?.unref === 'function') interval.unref();
  }, delay);
  if (typeof t?.unref === 'function') t.unref();
}

/** @type {Promise<unknown>|null} */
let activeSyncPromise = null;

export function isCacheSyncRunning() {
  return activeSyncPromise != null;
}

/**
 * Dispara sync em background (não bloqueia HTTP).
 * @returns {boolean} false se já havia sync rodando
 */
export function startFullSyncBackground(opts = {}) {
  if (activeSyncPromise) return false;
  activeSyncPromise = runFullSync(opts).finally(() => {
    activeSyncPromise = null;
  });
  return true;
}
