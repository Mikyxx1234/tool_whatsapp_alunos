import { isNovoCrmDbConfigured } from '../db/novoCrmClient.js';
import * as cacheRepo from '../repositories/novoCrmPersonCacheRepository.js';
import * as sourceRepo from '../repositories/novoCrmPersonSourceRepository.js';

const DEFAULT_BATCH_SIZE = 300;
const DEFAULT_BATCH_DELAY_MS = 200;
const OVERLAP_MS = 5 * 60 * 1000;

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

async function runFullSyncInternal({ dryRun = false } = {}) {
  if (!isNovoCrmDbConfigured()) {
    const err = new Error('Novo CRM DB não configurado. Defina NOVO_CRM_ENABLED=1 e NOVO_CRM_DATABASE_URL.');
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
  if (!isNovoCrmDbConfigured()) {
    console.log(
      '[novo-crm-cache-sync] NOVO_CRM DB não configurado — cron não iniciado (defina NOVO_CRM_ENABLED=1 e NOVO_CRM_DATABASE_URL).'
    );
    return;
  }

  const incMs = incrementalMinutes() * 60 * 1000;
  const incremental = setInterval(() => {
    startNovoCrmCacheSyncBackground({ mode: 'incremental' });
  }, incMs);
  if (typeof incremental?.unref === 'function') incremental.unref();

  const hour = fullHourUtc();
  const delay = msUntilHourUtc(hour);
  console.log(
    `[novo-crm-cache-sync] incremental a cada ${incrementalMinutes()} min; full em ${Math.round(delay / 60000)} min (${String(hour).padStart(2, '0')}:00 UTC).`
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
