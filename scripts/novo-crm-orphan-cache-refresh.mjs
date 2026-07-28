/**
 * Re-fetch ~3k orphan-window contacts from PROD API into local novo_crm_person_cache.
 * Targets: last_synced_at >= ORPHAN_FIELDS_SINCE (markPrimaryDealId + fields-fill window).
 * Does NOT run full/incremental sync.
 */
import 'dotenv/config';
import fs from 'node:fs';

// Prefer ORPHAN_CACHE_REFRESH_RATE; else bump to 6 for this script (overnight calm default is 2–4).
if (process.env.ORPHAN_CACHE_REFRESH_RATE) {
  process.env.NOVO_CRM_API_RATE_PER_SECOND = process.env.ORPHAN_CACHE_REFRESH_RATE;
} else if (!process.env.NOVO_CRM_API_RATE_PER_SECOND || Number(process.env.NOVO_CRM_API_RATE_PER_SECOND) < 5) {
  process.env.NOVO_CRM_API_RATE_PER_SECOND = '6';
}

const SINCE = process.env.ORPHAN_FIELDS_SINCE || '2026-07-28T13:14:00.000Z';
const MAX = Math.min(Math.max(Number(process.env.ORPHAN_CACHE_REFRESH_MAX) || 50000, 1), 50000);
const SKIP_LOCK = String(process.env.ORPHAN_CACHE_REFRESH_SKIP_LOCK || '').trim() === '1';
const CONCURRENCY = Math.min(
  Math.max(Number(process.env.ORPHAN_CACHE_REFRESH_CONCURRENCY) || 3, 1),
  6
);
const PROGRESS_EVERY_MS = Math.max(
  10000,
  Number(process.env.ORPHAN_CACHE_REFRESH_PROGRESS_MS) || 30000
);
const DRY_RUN = String(process.env.ORPHAN_CACHE_REFRESH_DRY_RUN || '').trim() === '1';

const stamp = Date.now();
const logPath = `data/orphan-cache-refresh-${stamp}.log`;
const summaryPath = `data/orphan-cache-refresh-${stamp}-summary.json`;

function log(...args) {
  const line = `[${new Date().toISOString()}] ${args.map(String).join(' ')}`;
  console.log(line);
  fs.appendFileSync(logPath, `${line}\n`);
}

async function kpiSnapshot(query, label) {
  const win = await query(
    `select count(*)::int as n,
            count(*) filter (where cpf_norm is null or btrim(cpf_norm)='')::int as sem_cpf,
            count(*) filter (where rgm_norm is null or btrim(rgm_norm)='')::int as sem_rgm,
            count(*) filter (where primary_deal_id is null or btrim(coalesce(primary_deal_id,''))='')::int as sem_deal
       from novo_crm_person_cache
      where is_deleted = false
        and last_synced_at >= $1::timestamptz`,
    [SINCE]
  );
  const global = await query(
    `select count(*)::int as n,
            count(*) filter (where cpf_norm is null or btrim(cpf_norm)='')::int as sem_cpf,
            count(*) filter (where rgm_norm is null or btrim(rgm_norm)='')::int as sem_rgm,
            count(*) filter (where primary_deal_id is null or btrim(coalesce(primary_deal_id,''))='')::int as sem_deal
       from novo_crm_person_cache
      where is_deleted = false`
  );
  const snap = { orphan_window: win.rows[0], global: global.rows[0] };
  log(`KPI ${label}`, JSON.stringify(snap));
  return snap;
}

const { query } = await import('../server/db/client.js');
const cacheRepo = await import('../server/repositories/novoCrmPersonCacheRepository.js');
const apiSource = await import('../server/repositories/novoCrmPersonApiSourceRepository.js');
const { getContact, isNovoCrmApiConfigured, getNovoCrmApiHost } = await import(
  '../server/services/novoCrmClient.js'
);

log('ORPHAN_CACHE_REFRESH start');
log('CRM host', getNovoCrmApiHost());
log('rate', process.env.NOVO_CRM_API_RATE_PER_SECOND);
log('since', SINCE);
log('concurrency', CONCURRENCY);
log('dry_run', DRY_RUN);
log('logPath', logPath);

if (!isNovoCrmApiConfigured()) {
  log('ABORT API not configured');
  process.exit(1);
}
apiSource.assertApiSourceReady();

const before = await kpiSnapshot(query, 'before');

log('LOAD contact ids from orphan window…');
const { rows: targets } = await query(
  `select contact_id, primary_deal_id
     from novo_crm_person_cache
    where is_deleted = false
      and last_synced_at >= $1::timestamptz
    order by last_synced_at asc
    limit $2`,
  [SINCE, MAX]
);
log('targets', targets.length);

if (!targets.length) {
  log('ABORT no targets');
  process.exit(0);
}

let release = null;
if (!DRY_RUN && !SKIP_LOCK) {
  release = await cacheRepo.acquireSyncLock();
  if (!release) {
    log('ABORT sync lock held (full/incremental already running). Set ORPHAN_CACHE_REFRESH_SKIP_LOCK=1 to override.');
    process.exit(1);
  }
} else if (SKIP_LOCK) {
  log('WARN skip sync lock');
}

const startMs = Date.now();
let done = 0;
let upserted = 0;
let skipped = 0;
let errors = 0;
let gotDeal = 0;
let gotCpf = 0;
let gotRgm = 0;
const errorSamples = [];
let lastProgressAt = startMs;

async function refreshOne(row) {
  const contactId = String(row.contact_id);
  try {
    const contact = await getContact(contactId);
    if (!contact?.id) {
      throw new Error('contact_not_found');
    }
    const deals = await apiSource.listDealsForContactId(contactId);
    if (deals.length) gotDeal += 1;

    const primaryIds = [];
    const primary =
      deals
        .slice()
        .sort((a, b) => {
          const ao = String(a.status || '').toUpperCase() === 'OPEN' ? 1 : 0;
          const bo = String(b.status || '').toUpperCase() === 'OPEN' ? 1 : 0;
          if (ao !== bo) return bo - ao;
          return String(b.updatedAt || '').localeCompare(String(a.updatedAt || ''));
        })[0] || null;
    if (primary?.id) primaryIds.push(String(primary.id));
    else if (row.primary_deal_id) primaryIds.push(String(row.primary_deal_id));

    const details = await apiSource.fetchDealDetailsByIds(primaryIds, {
      concurrency: 1,
      delayMs: 0,
    });

    const snapshot = apiSource.mapApiSnapshot(contact, deals, details);
    if (snapshot.cpfNorm) gotCpf += 1;
    if (snapshot.rgmNorm) gotRgm += 1;

    if (DRY_RUN) {
      skipped += 1;
      return;
    }

    const r = await cacheRepo.upsertSnapshot(snapshot, {
      syncLogId: null,
      fullSeenAt: null,
    });
    upserted += r.upserted;
    skipped += r.skipped;
  } catch (err) {
    errors += 1;
    if (errorSamples.length < 30) {
      errorSamples.push({
        contact_id: contactId,
        error: err?.message || String(err),
      });
    }
  } finally {
    done += 1;
    const now = Date.now();
    if (now - lastProgressAt >= PROGRESS_EVERY_MS || done === targets.length) {
      lastProgressAt = now;
      const elapsedSec = (now - startMs) / 1000;
      const rate = elapsedSec > 0 ? (done / elapsedSec).toFixed(2) : '0';
      const etaMin =
        done > 0
          ? (((targets.length - done) * elapsedSec) / done / 60).toFixed(1)
          : '?';
      log(
        `PROGRESS done=${done}/${targets.length} upserted=${upserted} skipped=${skipped} errors=${errors} got_deal=${gotDeal} got_cpf=${gotCpf} got_rgm=${gotRgm} contacts_per_s=${rate} elapsed_min=${(elapsedSec / 60).toFixed(1)} eta_min=${etaMin}`
      );
    }
  }
}

log('REFRESH start', targets.length);
try {
  let idx = 0;
  async function worker() {
    while (idx < targets.length) {
      const i = idx++;
      await refreshOne(targets[i]);
    }
  }
  await Promise.all(Array.from({ length: CONCURRENCY }, () => worker()));
} finally {
  if (release) await release().catch(() => {});
}

const after = await kpiSnapshot(query, 'after');
const durationMs = Date.now() - startMs;
const summary = {
  ok: errors === 0 || upserted > 0,
  dry_run: DRY_RUN,
  log_path: logPath,
  since: SINCE,
  targets: targets.length,
  done,
  upserted,
  skipped,
  errors,
  got_deal: gotDeal,
  got_cpf: gotCpf,
  got_rgm: gotRgm,
  duration_ms: durationMs,
  duration_min: Number((durationMs / 60000).toFixed(2)),
  rate: process.env.NOVO_CRM_API_RATE_PER_SECOND,
  concurrency: CONCURRENCY,
  crm_host: getNovoCrmApiHost(),
  before,
  after,
  delta: {
    global_sem_cpf: (before.global.sem_cpf || 0) - (after.global.sem_cpf || 0),
    global_sem_rgm: (before.global.sem_rgm || 0) - (after.global.sem_rgm || 0),
    window_sem_cpf: (before.orphan_window.sem_cpf || 0) - (after.orphan_window.sem_cpf || 0),
    window_sem_rgm: (before.orphan_window.sem_rgm || 0) - (after.orphan_window.sem_rgm || 0),
  },
  error_samples: errorSamples,
};

log('DONE', JSON.stringify({ ...summary, before: undefined, after: undefined, error_samples: undefined }));
if (errorSamples.length) log('error_samples', JSON.stringify(errorSamples.slice(0, 15)));
fs.writeFileSync(summaryPath, JSON.stringify(summary, null, 2));
log('ALL DONE', summaryPath);
process.exit(errors > 0 && upserted === 0 ? 1 : 0);
