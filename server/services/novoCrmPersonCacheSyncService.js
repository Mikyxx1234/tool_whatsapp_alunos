import { isNovoCrmDbConfigured } from '../db/novoCrmClient.js';
import { isNovoCrmApiConfigured } from './novoCrmClient.js';
import * as cacheRepo from '../repositories/novoCrmPersonCacheRepository.js';
import * as sourceRepo from '../repositories/novoCrmPersonSourceRepository.js';
import * as apiSource from '../repositories/novoCrmPersonApiSourceRepository.js';

const DEFAULT_BATCH_SIZE = 300;
const DEFAULT_BATCH_DELAY_MS = 200;
const OVERLAP_MS = 5 * 60 * 1000;

/**
 * api = HTTP com NOVO_CRM_API_TOKEN (org do token, ex. produção EduIT)
 * db  = Postgres NOVO_CRM_DATABASE_URL
 * auto = api se token ok, senão db
 */
export function resolveCacheSource() {
  const raw = String(process.env.NOVO_CRM_CACHE_SOURCE || 'auto')
    .trim()
    .toLowerCase();
  if (raw === 'api' || raw === 'http') return 'api';
  if (raw === 'db' || raw === 'postgres' || raw === 'database') return 'db';
  if (isNovoCrmApiConfigured()) return 'api';
  return 'db';
}

function batchSize() {
  return Math.min(
    Math.max(Number(process.env.NOVO_CRM_CACHE_BATCH_SIZE) || DEFAULT_BATCH_SIZE, 1),
    1000
  );
}

function batchDelayMs() {
  return Math.max(Number(process.env.NOVO_CRM_CACHE_BATCH_DELAY_MS) || DEFAULT_BATCH_DELAY_MS, 0);
}

function incrementalMinutes() {
  return Math.max(Number(process.env.NOVO_CRM_CACHE_INCREMENTAL_MINUTES) || 15, 5);
}

function fullHourUtc() {
  return Math.max(0, Math.min(23, Math.floor(Number(process.env.NOVO_CRM_CACHE_FULL_HOUR_UTC) || 3)));
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function minusOverlap(value) {
  if (!value) return new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  return new Date(new Date(value).getTime() - OVERLAP_MS).toISOString();
}

async function persistSnapshots(snapshots, { dryRun, syncLogId, fullSeenAt }) {
  let upserted = 0;
  let skipped = 0;
  let dataLossEvents = 0;
  if (dryRun) {
    return { upserted: snapshots.length, skipped: 0, dataLossEvents: 0 };
  }
  for (const snapshot of snapshots) {
    const r = await cacheRepo.upsertSnapshot(snapshot, { syncLogId, fullSeenAt });
    upserted += r.upserted;
    skipped += r.skipped;
    dataLossEvents += r.dataLossInserted;
  }
  return { upserted, skipped, dataLossEvents };
}

async function runFullSyncViaApi({ dryRun = false } = {}) {
  apiSource.assertApiSourceReady();

  const release = await cacheRepo.acquireSyncLock();
  if (!release) {
    const err = new Error('Sync Novo CRM já em andamento');
    err.status = 409;
    throw err;
  }

  let logId = null;
  const startMs = Date.now();
  let batches = 0;
  let contactsSeen = 0;
  let upserted = 0;
  let skipped = 0;
  let deleted = 0;
  let dataLossEvents = 0;
  let maxSourceUpdatedAt = null;
  const contactPerPage = Math.min(Math.max(Number(process.env.NOVO_CRM_CACHE_API_CONTACT_PER_PAGE) || 200, 1), 200);

  try {
    const fullSeenAt = new Date().toISOString();
    const contactsTotal = await apiSource.countAllContactsViaApi();
    logId = await cacheRepo.recordSyncStart({ mode: 'full', contactsTotal });
    console.log(
      `[novo-crm-cache-sync] full via API: ${contactsTotal} contacts — indexando deals…`
    );

    const dealsByContact = await apiSource.loadAllDealsByContactId({
      delayMs: batchDelayMs(),
      onProgress: (p) => {
        if (p.page % 20 === 0 || p.page === 1) {
          console.log(
            `[novo-crm-cache-sync] deals page ${p.page}/${p.totalPages ?? '?'} seen=${p.seen}/${p.total}`
          );
        }
      },
    });
    console.log(
      `[novo-crm-cache-sync] deals index: ${dealsByContact.size} contacts com negócio(s)`
    );

    let page = 1;
    let totalPages = Math.ceil(contactsTotal / contactPerPage) || 1;
    const fetchFields = apiSource.shouldFetchDealFields();

    while (page <= totalPages) {
      const res = await apiSource.listContactsApiPage({ page, perPage: contactPerPage });
      if (res.totalPages) totalPages = res.totalPages;
      if (!res.items.length) break;

      batches += 1;
      contactsSeen += res.items.length;

      /** @type {string[]} */
      const primaryIds = [];
      for (const c of res.items) {
        const deals = dealsByContact.get(String(c.id)) || [];
        const primary = deals
          .slice()
          .sort((a, b) => {
            const ao = String(a.status || '').toUpperCase() === 'OPEN' ? 1 : 0;
            const bo = String(b.status || '').toUpperCase() === 'OPEN' ? 1 : 0;
            if (ao !== bo) return bo - ao;
            return String(b.updatedAt || '').localeCompare(String(a.updatedAt || ''));
          })[0];
        if (primary?.id) primaryIds.push(String(primary.id));
      }

      const details = fetchFields
        ? await apiSource.fetchDealDetailsByIds(primaryIds, {
            concurrency: Number(process.env.NOVO_CRM_CACHE_API_DEAL_CONCURRENCY) || 2,
            delayMs: Number(process.env.NOVO_CRM_CACHE_API_DEAL_DELAY_MS) || 150,
          })
        : new Map();

      const snapshots = res.items.map((c) =>
        apiSource.mapApiSnapshot(c, dealsByContact.get(String(c.id)) || [], details)
      );

      const persisted = await persistSnapshots(snapshots, { dryRun, syncLogId: logId, fullSeenAt });
      upserted += persisted.upserted;
      skipped += persisted.skipped;
      dataLossEvents += persisted.dataLossEvents;
      for (const s of snapshots) {
        if (!s.sourceUpdatedAt) continue;
        if (!maxSourceUpdatedAt || s.sourceUpdatedAt > maxSourceUpdatedAt) {
          maxSourceUpdatedAt = s.sourceUpdatedAt;
        }
      }

      if (!dryRun) {
        await cacheRepo
          .recordSyncProgress(logId, {
            batches,
            contactsSeen,
            upserted,
            skipped,
            dataLossEvents,
          })
          .catch(() => {});
      }

      console.log(
        `[novo-crm-cache-sync] contacts page ${page}/${totalPages} seen=${contactsSeen} upserted=${upserted}`
      );

      if (res.items.length < contactPerPage) break;
      page += 1;
      if (batchDelayMs() > 0) await sleep(batchDelayMs());
    }

    if (!dryRun) {
      deleted = await cacheRepo.markDeletedNotSeenSince(fullSeenAt);
      if (maxSourceUpdatedAt) {
        await cacheRepo.updateSyncState({
          cursorUpdatedAt: maxSourceUpdatedAt,
          cursorId: null,
        });
      }
    }

    const durationMs = Date.now() - startMs;
    await cacheRepo.recordSyncFinish(logId, {
      status: 'ok',
      cursorFinishedAt: maxSourceUpdatedAt,
      batches,
      contactsSeen,
      upserted,
      skipped,
      deleted,
      dataLossEvents,
    });
    console.log(
      `[novo-crm-cache-sync] full API ok batches=${batches} seen=${contactsSeen} upserted=${upserted} deleted=${deleted} ${durationMs}ms`
    );
    return {
      ok: true,
      mode: 'full',
      source: 'api',
      logId,
      batches,
      contactsSeen,
      upserted,
      skipped,
      deleted,
      dataLossEvents,
      durationMs,
      dry_run: dryRun,
    };
  } catch (err) {
    if (logId) {
      await cacheRepo
        .recordSyncFinish(logId, {
          status: 'error',
          batches,
          contactsSeen,
          upserted,
          skipped,
          deleted,
          dataLossEvents,
          errorMessage: err?.message || String(err),
        })
        .catch(() => {});
    }
    throw err;
  } finally {
    await release().catch(() => {});
  }
}

async function runFullSyncInternal({ dryRun = false } = {}) {
  const source = resolveCacheSource();
  if (source === 'api') {
    return runFullSyncViaApi({ dryRun });
  }

  if (!isNovoCrmDbConfigured()) {
    const err = new Error(
      'Novo CRM DB não configurado. Defina NOVO_CRM_ENABLED=1 e NOVO_CRM_DATABASE_URL (ou NOVO_CRM_CACHE_SOURCE=api + token).'
    );
    err.status = 503;
    throw err;
  }

  const release = await cacheRepo.acquireSyncLock();
  if (!release) {
    const err = new Error('Sync Novo CRM já em andamento');
    err.status = 409;
    throw err;
  }

  let logId = null;
  const startMs = Date.now();
  let batches = 0;
  let contactsSeen = 0;
  let upserted = 0;
  let skipped = 0;
  let deleted = 0;
  let dataLossEvents = 0;
  let afterId = null;
  let maxSourceUpdatedAt = null;

  try {
    const fullSeenAt = new Date().toISOString();
    let contactsTotal = null;
    try {
      contactsTotal = await sourceRepo.countAllContacts();
    } catch {
      contactsTotal = null;
    }
    logId = await cacheRepo.recordSyncStart({ mode: 'full', contactsTotal });

    while (true) {
      const ids = await sourceRepo.listFullContactIdsPage({ afterId, limit: batchSize() });
      if (!ids.length) break;
      batches += 1;
      contactsSeen += ids.length;
      afterId = ids[ids.length - 1];

      const snapshots = await sourceRepo.loadSnapshotsByContactIds(ids);
      const persisted = await persistSnapshots(snapshots, { dryRun, syncLogId: logId, fullSeenAt });
      upserted += persisted.upserted;
      skipped += persisted.skipped;
      dataLossEvents += persisted.dataLossEvents;
      for (const s of snapshots) {
        if (!s.sourceUpdatedAt) continue;
        if (!maxSourceUpdatedAt || s.sourceUpdatedAt > maxSourceUpdatedAt) maxSourceUpdatedAt = s.sourceUpdatedAt;
      }

      if (!dryRun) {
        await cacheRepo
          .recordSyncProgress(logId, {
            batches,
            contactsSeen,
            upserted,
            skipped,
            dataLossEvents,
          })
          .catch(() => {});
      }

      if (ids.length < batchSize()) break;
      if (batchDelayMs() > 0) await sleep(batchDelayMs());
    }

    if (!dryRun) {
      deleted = await cacheRepo.markDeletedNotSeenSince(fullSeenAt);
      if (maxSourceUpdatedAt) {
        await cacheRepo.updateSyncState({ cursorUpdatedAt: maxSourceUpdatedAt, cursorId: afterId });
      }
    }

    const durationMs = Date.now() - startMs;
    await cacheRepo.recordSyncFinish(logId, {
      status: 'ok',
      cursorFinishedAt: maxSourceUpdatedAt,
      batches,
      contactsSeen,
      upserted,
      skipped,
      deleted,
      dataLossEvents,
    });
    console.log(
      `[novo-crm-cache-sync] full ok batches=${batches} seen=${contactsSeen} upserted=${upserted} skipped=${skipped} deleted=${deleted} events=${dataLossEvents} ${durationMs}ms dry=${dryRun}`
    );
    return {
      ok: true,
      mode: 'full',
      source: 'db',
      logId,
      batches,
      contactsSeen,
      upserted,
      skipped,
      deleted,
      dataLossEvents,
      durationMs,
      dry_run: dryRun,
    };
  } catch (err) {
    if (logId) {
      await cacheRepo
        .recordSyncFinish(logId, {
          status: 'error',
          batches,
          contactsSeen,
          upserted,
          skipped,
          deleted,
          dataLossEvents,
          errorMessage: err?.message || String(err),
        })
        .catch(() => {});
    }
    throw err;
  } finally {
    await release().catch(() => {});
  }
}

async function runIncrementalSyncInternal({ dryRun = false, maxBatches = null } = {}) {
  // Incremental via API ainda não tem filtro updatedAt estável — full cobre.
  if (resolveCacheSource() === 'api') {
    console.log('[novo-crm-cache-sync] incremental ignorado (source=api); use full.');
    return { ok: true, skipped_api_source: true, hint: 'Use mode=full com NOVO_CRM_CACHE_SOURCE=api' };
  }
  if (!isNovoCrmDbConfigured()) {
    return { ok: true, skipped_no_config: true };
  }

  const release = await cacheRepo.acquireSyncLock();
  if (!release) {
    return { ok: false, already_running: true };
  }

  let logId = null;
  const startMs = Date.now();
  let batches = 0;
  let contactsSeen = 0;
  let upserted = 0;
  let skipped = 0;
  let dataLossEvents = 0;
  let afterUpdatedAt = null;
  let afterId = null;
  let maxSourceUpdatedAt = null;
  const batchLimit = maxBatches ?? Math.max(Number(process.env.NOVO_CRM_CACHE_INCREMENTAL_MAX_BATCHES) || 20, 1);

  try {
    const state = await cacheRepo.getSyncState();
    const since = minusOverlap(state?.cursor_updated_at);
    maxSourceUpdatedAt = state?.cursor_updated_at
      ? new Date(state.cursor_updated_at).toISOString()
      : null;
    logId = await cacheRepo.recordSyncStart({ mode: 'incremental', cursorStartedAt: since });

    while (batches < batchLimit) {
      const page = await sourceRepo.listUpdatedContactIdsSince(since, {
        afterUpdatedAt,
        afterId,
        limit: batchSize(),
      });
      if (!page.length) break;
      batches += 1;
      contactsSeen += page.length;
      const ids = page.map((p) => p.id);
      const last = page[page.length - 1];
      afterUpdatedAt = last.updatedAt;
      afterId = last.id;

      const snapshots = await sourceRepo.loadSnapshotsByContactIds(ids);
      const persisted = await persistSnapshots(snapshots, {
        dryRun,
        syncLogId: logId,
        fullSeenAt: null,
      });
      upserted += persisted.upserted;
      skipped += persisted.skipped;
      dataLossEvents += persisted.dataLossEvents;
      for (const s of snapshots) {
        if (!s.sourceUpdatedAt) continue;
        if (!maxSourceUpdatedAt || s.sourceUpdatedAt > maxSourceUpdatedAt) maxSourceUpdatedAt = s.sourceUpdatedAt;
      }

      if (!dryRun) {
        await cacheRepo
          .recordSyncProgress(logId, { batches, contactsSeen, upserted, skipped, dataLossEvents })
          .catch(() => {});
      }

      if (page.length < batchSize()) break;
      if (batchDelayMs() > 0) await sleep(batchDelayMs());
    }

    if (!dryRun && maxSourceUpdatedAt) {
      await cacheRepo.updateSyncState({ cursorUpdatedAt: maxSourceUpdatedAt, cursorId: afterId });
    }
    const durationMs = Date.now() - startMs;
    await cacheRepo.recordSyncFinish(logId, {
      status: 'ok',
      cursorFinishedAt: maxSourceUpdatedAt,
      batches,
      contactsSeen,
      upserted,
      skipped,
      dataLossEvents,
    });
    console.log(
      `[novo-crm-cache-sync] incremental ok batches=${batches} seen=${contactsSeen} upserted=${upserted} skipped=${skipped} events=${dataLossEvents} ${durationMs}ms dry=${dryRun}`
    );
    return {
      ok: true,
      mode: 'incremental',
      logId,
      batches,
      contactsSeen,
      upserted,
      skipped,
      dataLossEvents,
      durationMs,
      dry_run: dryRun,
    };
  } catch (err) {
    if (logId) {
      await cacheRepo
        .recordSyncFinish(logId, {
          status: 'error',
          batches,
          contactsSeen,
          upserted,
          skipped,
          dataLossEvents,
          errorMessage: err?.message || String(err),
        })
        .catch(() => {});
    }
    throw err;
  } finally {
    await release().catch(() => {});
  }
}

let activeSyncPromise = null;

export function isNovoCrmCacheSyncRunning() {
  return activeSyncPromise != null;
}

export async function runNovoCrmCacheSync({ mode = 'incremental', dryRun = false } = {}) {
  const normalized = mode === 'full' ? 'full' : 'incremental';
  return normalized === 'full'
    ? runFullSyncInternal({ dryRun })
    : runIncrementalSyncInternal({ dryRun });
}

export function startNovoCrmCacheSyncBackground(opts = {}) {
  if (activeSyncPromise) return false;
  activeSyncPromise = runNovoCrmCacheSync(opts)
    .catch((err) => {
      console.error('[novo-crm-cache-sync] background FAIL:', err?.message || String(err));
      return null;
    })
    .finally(() => {
      activeSyncPromise = null;
    });
  return true;
}

function msUntilHourUtc(hourUtc) {
  const now = new Date();
  const next = new Date(now);
  next.setUTCHours(hourUtc, 0, 0, 0);
  if (next <= now) next.setUTCDate(next.getUTCDate() + 1);
  return next.getTime() - now.getTime();
}

export function startNovoCrmCacheSyncCron() {
  if (String(process.env.NOVO_CRM_CACHE_ENABLED ?? '1') === '0') {
    console.log('[novo-crm-cache-sync] Cache desabilitado (NOVO_CRM_CACHE_ENABLED=0).');
    return;
  }

  const sourceRaw = String(process.env.NOVO_CRM_CACHE_SOURCE || 'auto').trim();
  const enabled = String(process.env.NOVO_CRM_ENABLED || '').trim() === '1';
  const hasToken = Boolean(String(process.env.NOVO_CRM_API_TOKEN || '').trim());
  const source = resolveCacheSource();

  console.log(
    `[novo-crm-cache-sync] boot: CACHE_SOURCE=${sourceRaw || '(vazio)'} → ${source}; ENABLED=${enabled ? 1 : 0}; token=${hasToken ? 'sim' : 'não'}`
  );

  if (source === 'api') {
    if (!isNovoCrmApiConfigured()) {
      console.log(
        '[novo-crm-cache-sync] source=api mas API incompleta — cron NÃO iniciado. Defina NOVO_CRM_ENABLED=1 e NOVO_CRM_API_TOKEN e faça redeploy.'
      );
      return;
    }
  } else if (source === 'db') {
    if (!isNovoCrmDbConfigured()) {
      console.log(
        '[novo-crm-cache-sync] source=db mas NOVO_CRM_DATABASE_URL ausente — cron NÃO iniciado. Para produção EduIT use NOVO_CRM_CACHE_SOURCE=api + NOVO_CRM_ENABLED=1 + NOVO_CRM_API_TOKEN.'
      );
      return;
    }
  }

  const incMs = incrementalMinutes() * 60 * 1000;
  if (source === 'db') {
    const incremental = setInterval(() => {
      startNovoCrmCacheSyncBackground({ mode: 'incremental' });
    }, incMs);
    if (typeof incremental?.unref === 'function') incremental.unref();
  }

  const hour = fullHourUtc();
  const delay = msUntilHourUtc(hour);
  console.log(
    `[novo-crm-cache-sync] source=${source}; ${
      source === 'db' ? `incremental a cada ${incrementalMinutes()} min; ` : ''
    }full em ${Math.round(delay / 60000)} min (${String(hour).padStart(2, '0')}:00 UTC).`
  );

  const firstFull = setTimeout(() => {
    startNovoCrmCacheSyncBackground({ mode: 'full' });
    const daily = setInterval(() => {
      startNovoCrmCacheSyncBackground({ mode: 'full' });
    }, 24 * 60 * 60 * 1000);
    if (typeof daily?.unref === 'function') daily.unref();
  }, delay);
  if (typeof firstFull?.unref === 'function') firstFull.unref();
}
