import { isNovoCrmDbConfigured } from '../db/novoCrmClient.js';
import { isNovoCrmApiConfigured } from './novoCrmClient.js';
import { isProdCrmHost } from '../utils/novoCrmStageRules.js';
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
  // Default 05:00 UTC = 02:00 BRT (madrugada; antes de provision/fields).
  return Math.max(0, Math.min(23, Math.floor(Number(process.env.NOVO_CRM_CACHE_FULL_HOUR_UTC) || 5)));
}

function msUntilHourUtc(hourUtc) {
  const now = new Date();
  const next = new Date(now);
  next.setUTCHours(hourUtc, 0, 0, 0);
  if (next <= now) next.setUTCDate(next.getUTCDate() + 1);
  return next.getTime() - now.getTime();
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Cancel cooperativo do Full/Incremental espelho (operador no painel). */
let cacheSyncCancelRequested = false;

/** Progresso em memória — a fase index_deals não grava contacts_seen no log. */
let cacheSyncLive = null;

function setCacheSyncLive(patch) {
  cacheSyncLive = cacheSyncLive ? { ...cacheSyncLive, ...patch } : { ...patch };
}

export function getRunningNovoCrmCacheSyncJob() {
  return cacheSyncLive;
}

export function isNovoCrmCacheSyncRunning() {
  return Boolean(activeSyncPromise);
}

export function getNovoCrmNightCronStatus() {
  const cacheOn = String(process.env.NOVO_CRM_CACHE_ENABLED ?? '1') !== '0';
  const fieldsOn = String(process.env.NOVO_CRM_FIELDS_SYNC_ENABLED || '').trim() === '1';
  const flagsOn = String(process.env.NOVO_CRM_FLAGS_SYNC_ENABLED || '').trim() === '1';
  const provisionOn = String(process.env.NOVO_CRM_PROVISION_ENABLED || '').trim() === '1';
  const fieldsHour = Math.max(
    0,
    Math.min(23, Math.floor(Number(process.env.NOVO_CRM_FIELDS_SYNC_HOUR_UTC) || 8))
  );
  const cacheHour = fullHourUtc();
  return {
    cache_enabled: cacheOn,
    cache_source: resolveCacheSource(),
    cache_full_hour_utc: cacheHour,
    cache_next_ms: cacheOn ? msUntilHourUtc(cacheHour) : null,
    fetch_deal_fields: apiSource.shouldFetchDealFields(),
    fields_enabled: fieldsOn,
    fields_hour_utc: fieldsHour,
    fields_next_ms: fieldsOn ? msUntilHourUtc(fieldsHour) : null,
    flags_enabled: flagsOn,
    provision_enabled: provisionOn,
    api_configured: isNovoCrmApiConfigured(),
  };
}

export async function requestCancelNovoCrmCacheSync() {
  if (activeSyncPromise) {
    cacheSyncCancelRequested = true;
    console.log('[novo-crm-cache-sync] cancel requested by operator');
    return { ok: true, status: 'cancelling' };
  }
  // Rebuild/restart mata o processo mas deixa a linha `running` no Postgres.
  // Parar precisa fechar o fantasma, senão o próximo Full Sync dá 409.
  const closed = await cacheRepo.forceFinishRunningSyncs(
    'cancelado pelo operador (job não estava em memória)'
  );
  if (closed > 0) {
    console.log(`[novo-crm-cache-sync] closed ${closed} stale running log(s)`);
    return { ok: true, status: 'closed_stale', closed };
  }
  return { ok: false, error: 'Nenhum Full Sync em andamento' };
}

export function isNovoCrmCacheSyncCancelRequested() {
  return cacheSyncCancelRequested;
}

function clearCacheSyncCancel() {
  cacheSyncCancelRequested = false;
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

function resolveContactCap(contactsTotal, { maxContacts = null, samplePct = null } = {}) {
  let cap = null;
  const pct = samplePct != null ? Number(samplePct) : NaN;
  if (Number.isFinite(pct) && pct > 0 && pct < 100) {
    cap = Math.max(1, Math.ceil(contactsTotal * (pct / 100)));
  }
  const max = maxContacts != null ? Number(maxContacts) : NaN;
  if (Number.isFinite(max) && max > 0) {
    cap = cap == null ? Math.floor(max) : Math.min(cap, Math.floor(max));
  }
  if (cap != null && cap >= contactsTotal) return null;
  return cap;
}

async function runFullSyncViaApi({ dryRun = false, maxContacts = null, samplePct = null } = {}) {
  apiSource.assertApiSourceReady();
  clearCacheSyncCancel();

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
  let emptyDealsVerified = 0;
  let emptyDealsVerifyErrors = 0;
  let dealsRecovered = 0;
  const contactPerPage = Math.min(Math.max(Number(process.env.NOVO_CRM_CACHE_API_CONTACT_PER_PAGE) || 200, 1), 200);
  const verifyEmptyDeals =
    String(process.env.NOVO_CRM_CACHE_VERIFY_EMPTY_DEALS ?? '1').trim() !== '0';

  try {
    const fullSeenAt = new Date().toISOString();
    const contactsTotal = await apiSource.countAllContactsViaApi();
    const contactCap = resolveContactCap(contactsTotal, { maxContacts, samplePct });
    const truncated = contactCap != null;
    logId = await cacheRepo.recordSyncStart({ mode: 'full', contactsTotal });
    setCacheSyncLive({
      phase: truncated ? 'contacts' : 'index_deals',
      status_message: truncated
        ? `Amostra de ${contactCap} contatos…`
        : `Indexando negócios (antes dos ${contactsTotal.toLocaleString('pt-BR')} contatos)…`,
      contacts_total: contactsTotal,
      contacts_seen: 0,
      cache_upserted: 0,
    });
    console.log(
      `[novo-crm-cache-sync] full via API: ${contactsTotal} contacts${
        truncated ? ` — AMOSTRA max=${contactCap} (sem markDeleted)` : ' — indexando deals…'
      }`
    );

    /** @type {Map<string, object[]>|null} */
    let dealsByContact = null;
    if (!truncated) {
      dealsByContact = await apiSource.loadAllDealsByContactId({
        delayMs: batchDelayMs(),
        shouldCancel: () => cacheSyncCancelRequested,
        onProgress: (p) => {
          setCacheSyncLive({
            phase: 'index_deals',
            status_message: `Indexando negócios ${p.page}/${p.totalPages ?? '?'} · ${Number(p.seen || 0).toLocaleString('pt-BR')} de ${Number(p.total || 0).toLocaleString('pt-BR')}`,
            deals_page: p.page,
            deals_total_pages: p.totalPages,
            deals_seen: p.seen,
            deals_total: p.total,
            contacts_total: contactsTotal,
          });
          if (p.page === 1 || p.page % 5 === 0) {
            cacheRepo
              .recordSyncProgress(logId, {
                batches: p.page,
                contactsSeen: 0,
                upserted: 0,
                skipped: 0,
                dataLossEvents: 0,
              })
              .catch(() => {});
          }
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
    }

    if (cacheSyncCancelRequested) {
      const durationMs = Date.now() - startMs;
      await cacheRepo.recordSyncFinish(logId, {
        status: 'cancelled',
        batches,
        contactsSeen: 0,
        upserted: 0,
        skipped: 0,
        deleted: 0,
        dataLossEvents: 0,
        errorMessage: 'cancelado pelo operador (durante índice de negócios)',
      });
      return {
        ok: false,
        mode: 'full',
        source: 'api',
        logId,
        cancelled: true,
        contacts_total: contactsTotal,
        durationMs,
      };
    }

    let page = 1;
    let totalPages = Math.ceil(contactsTotal / contactPerPage) || 1;
    const fetchFields = apiSource.shouldFetchDealFields();
    setCacheSyncLive({
      phase: 'contacts',
      status_message: fetchFields
        ? 'Copiando contatos (com GET de campos por deal)…'
        : 'Copiando contatos para o espelho…',
      contacts_total: contactsTotal,
      contacts_seen: 0,
    });

    while (page <= totalPages) {
      if (cacheSyncCancelRequested) break;
      if (truncated && contactsSeen >= contactCap) break;

      const res = await apiSource.listContactsApiPage({ page, perPage: contactPerPage });
      if (res.totalPages) totalPages = res.totalPages;
      if (!res.items.length) break;

      let items = res.items;
      if (truncated && contactsSeen + items.length > contactCap) {
        items = items.slice(0, contactCap - contactsSeen);
      }
      if (!items.length) break;

      batches += 1;
      contactsSeen += items.length;

      /** @type {Map<string, object[]>} */
      const pageDeals = new Map();
      if (dealsByContact) {
        for (const c of items) {
          const cid = String(c.id);
          let deals = dealsByContact.get(cid) || [];
          // Índice em lote perde deals (deriva de paginação) e o contact vira
          // falso órfão no espelho. Confere ao vivo quem ficou sem negócio.
          if (!deals.length && verifyEmptyDeals) {
            emptyDealsVerified += 1;
            try {
              deals = await apiSource.listDealsForContactId(cid);
              if (deals.length) dealsRecovered += deals.length;
            } catch (err) {
              emptyDealsVerifyErrors += 1;
              console.warn(
                `[novo-crm-cache-sync] verificação de deals falhou contact=${cid}:`,
                err?.message || err
              );
              deals = [];
            }
          }
          pageDeals.set(cid, deals);
        }
      } else {
        for (const c of items) {
          const deals = await apiSource.listDealsForContactId(String(c.id));
          pageDeals.set(String(c.id), deals);
        }
      }

      /** @type {string[]} */
      const primaryIds = [];
      for (const c of items) {
        const deals = pageDeals.get(String(c.id)) || [];
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

      const snapshots = items.map((c) =>
        apiSource.mapApiSnapshot(c, pageDeals.get(String(c.id)) || [], details)
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
      setCacheSyncLive({
        phase: 'contacts',
        contacts_total: contactsTotal,
        contacts_seen: contactsSeen,
        cache_upserted: upserted,
        status_message: `Contatos ${contactsSeen.toLocaleString('pt-BR')} / ${contactsTotal.toLocaleString('pt-BR')} · ${upserted.toLocaleString('pt-BR')} upserts`,
      });

      console.log(
        `[novo-crm-cache-sync] contacts page ${page}/${totalPages} seen=${contactsSeen}${
          truncated ? `/${contactCap}` : ''
        } upserted=${upserted}`
      );

      if (truncated && contactsSeen >= contactCap) break;
      // Página curta no meio = deriva de paginação, não fim da lista.
      if (totalPages != null && page >= totalPages) break;
      page += 1;
      if (batchDelayMs() > 0) await sleep(batchDelayMs());
    }

    const cancelled = cacheSyncCancelRequested;
    const completeEnough =
      Number(contactsTotal) > 0 && contactsSeen >= Math.floor(Number(contactsTotal) * 0.95);
    if (!dryRun) {
      // Amostra / cancel / full incompleto NÃO podem markDeleted — o #54
      // (27/08) viu 17k/42k, status ok, e marcou 25k como apagados.
      if (!truncated && !cancelled && completeEnough) {
        deleted = await cacheRepo.markDeletedNotSeenSince(fullSeenAt);
      } else {
        console.log(
          `[novo-crm-cache-sync] markDeleted pulado (truncated=${truncated} cancelled=${cancelled} complete=${completeEnough} seen=${contactsSeen}/${contactsTotal})`
        );
      }
      if (maxSourceUpdatedAt && !cancelled && completeEnough) {
        await cacheRepo.updateSyncState({
          cursorUpdatedAt: maxSourceUpdatedAt,
          cursorId: null,
        });
      }
    }

    const durationMs = Date.now() - startMs;
    const incompleteMsg =
      !cancelled && !completeEnough
        ? `incompleto: seen=${contactsSeen}/${contactsTotal} (markDeleted pulado)`
        : null;
    await cacheRepo.recordSyncFinish(logId, {
      status: cancelled || incompleteMsg ? 'error' : 'ok',
      cursorFinishedAt: maxSourceUpdatedAt,
      batches,
      contactsSeen,
      upserted,
      skipped,
      deleted,
      dataLossEvents,
      errorMessage: cancelled ? 'cancelado pelo operador' : incompleteMsg,
    });
    console.log(
      `[novo-crm-cache-sync] full API ${cancelled ? 'cancelled' : incompleteMsg ? 'incomplete' : 'ok'} batches=${batches} seen=${contactsSeen} upserted=${upserted} deleted=${deleted} truncated=${truncated} deals_recuperados=${dealsRecovered}/${emptyDealsVerified} ${durationMs}ms`
    );
    return {
      ok: !cancelled && !incompleteMsg,
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
      truncated,
      contact_cap: contactCap,
      contacts_total: contactsTotal,
      empty_deals_verified: emptyDealsVerified,
      empty_deals_verify_errors: emptyDealsVerifyErrors,
      deals_recovered: dealsRecovered,
      cancelled,
      incomplete: Boolean(incompleteMsg),
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

async function runFullSyncInternal({ dryRun = false, maxContacts = null, samplePct = null } = {}) {
  const source = resolveCacheSource();
  if (source === 'api') {
    return runFullSyncViaApi({ dryRun, maxContacts, samplePct });
  }

  if (!isNovoCrmDbConfigured()) {
    const err = new Error(
      'Novo CRM DB não configurado. Defina NOVO_CRM_ENABLED=1 e NOVO_CRM_DATABASE_URL (ou NOVO_CRM_CACHE_SOURCE=api + token).'
    );
    err.status = 503;
    throw err;
  }

  clearCacheSyncCancel();
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
      if (cacheSyncCancelRequested) break;
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

    const cancelled = cacheSyncCancelRequested;
    if (!dryRun) {
      if (!cancelled) {
        deleted = await cacheRepo.markDeletedNotSeenSince(fullSeenAt);
        if (maxSourceUpdatedAt) {
          await cacheRepo.updateSyncState({ cursorUpdatedAt: maxSourceUpdatedAt, cursorId: afterId });
        }
      } else {
        console.log(
          `[novo-crm-cache-sync] cancel: markDeleted/cursor pulados (seen=${contactsSeen})`
        );
      }
    }

    const durationMs = Date.now() - startMs;
    await cacheRepo.recordSyncFinish(logId, {
      status: cancelled ? 'cancelled' : 'ok',
      cursorFinishedAt: maxSourceUpdatedAt,
      batches,
      contactsSeen,
      upserted,
      skipped,
      deleted,
      dataLossEvents,
      errorMessage: cancelled ? 'cancelado pelo operador' : null,
    });
    console.log(
      `[novo-crm-cache-sync] full ${cancelled ? 'cancelled' : 'ok'} batches=${batches} seen=${contactsSeen} upserted=${upserted} skipped=${skipped} deleted=${deleted} events=${dataLossEvents} ${durationMs}ms dry=${dryRun}`
    );
    return {
      ok: !cancelled,
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
      cancelled,
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

export async function runNovoCrmCacheSync({
  mode = 'incremental',
  dryRun = false,
  maxContacts = null,
  samplePct = null,
} = {}) {
  const normalized = mode === 'full' ? 'full' : 'incremental';
  return normalized === 'full'
    ? runFullSyncInternal({ dryRun, maxContacts, samplePct })
    : runIncrementalSyncInternal({ dryRun });
}

export function startNovoCrmCacheSyncBackground(opts = {}) {
  if (activeSyncPromise) {
    console.log('[novo-crm-cache-sync] já em andamento — start ignorado');
    return false;
  }
  clearCacheSyncCancel();
  cacheSyncLive = {
    phase: 'starting',
    status_message: 'Iniciando Full Sync…',
    contacts_total: null,
    contacts_seen: 0,
    cache_upserted: 0,
    deals_page: 0,
    deals_total_pages: null,
    deals_seen: 0,
    deals_total: 0,
    started_at: new Date().toISOString(),
  };
  activeSyncPromise = runNovoCrmCacheSync(opts)
    .catch((err) => {
      console.error('[novo-crm-cache-sync] background FAIL:', err?.message || err);
      return null;
    })
    .finally(() => {
      activeSyncPromise = null;
      cacheSyncLive = null;
      clearCacheSyncCancel();
    });
  return true;
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

  let crmHost = '(n/d)';
  try {
    crmHost = new URL(
      String(process.env.NOVO_CRM_API_BASE_URL || '')
    ).host;
  } catch {
    crmHost = String(process.env.NOVO_CRM_API_BASE_URL || '(vazio)');
  }
  const isProdHost = isProdCrmHost(crmHost);

  console.log(
    `[novo-crm-cache-sync] boot: CACHE_SOURCE=${sourceRaw || '(vazio)'} → ${source}; ENABLED=${enabled ? 1 : 0}; token=${hasToken ? 'sim' : 'não'}; CRM_HOST=${crmHost} (${isProdHost ? 'PRODUÇÃO' : 'DEV/outro'}); FETCH_DEAL_FIELDS=${apiSource.shouldFetchDealFields() ? '1' : '0'}`
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
