/**
 * Dry-run cleanup plan (orphan spam 2026-07-28). PROD API — no deletes.
 *
 * Fast path:
 *  1) load SCAN_CACHE (today deals by contact)
 *  2) listDeals for each contact (find priors)
 *  3) flat getDeal pool for all deal ids
 *  4) plan keep/delete; checkpoint every N contacts
 *
 * Env: SCAN_CACHE, DRY_RATE=8, CONTACT_CONCURRENCY=8, ONLY_MULTI_TODAY=1,
 *      CHECKPOINT=data/orphan-spam-cleanup-checkpoint.json, RESUME=1
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRateLimiter } from '../server/utils/rateLimiter.js';
import { normalizeRgm } from '../server/utils/novoCrmCacheNormalize.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const DATA = path.join(ROOT, 'data');

try {
  const dotenv = await import('dotenv');
  dotenv.config({ path: path.join(ROOT, '.env'), override: false });
} catch {
  /* optional */
}

const API = String(process.env.NOVO_CRM_API_BASE_URL || '').trim().replace(/\/$/, '');
const TOKEN = String(process.env.NOVO_CRM_API_TOKEN || '').trim();
if (!API || !TOKEN) {
  console.error('Missing NOVO_CRM_API_BASE_URL / NOVO_CRM_API_TOKEN');
  process.exit(1);
}

const TODAY_BRT = '2026-07-28';
const TODAY_START = new Date(`${TODAY_BRT}T03:00:00.000Z`);
const DRY_RATE = Math.max(1, Math.min(20, Number(process.env.DRY_RATE) || 8));
const LIST_CONCURRENCY = Math.min(Math.max(Number(process.env.LIST_CONCURRENCY) || 8, 1), 16);
const GET_CONCURRENCY = Math.min(Math.max(Number(process.env.GET_CONCURRENCY) || 10, 1), 20);
const MAX_CONTACTS = Math.max(0, Number(process.env.MAX_CONTACTS) || 0);
const ONLY_MULTI_TODAY = String(process.env.ONLY_MULTI_TODAY || '1') === '1'; // default ON for speed
const INCLUDE_SINGLES = String(process.env.INCLUDE_SINGLES || '0') === '1';
const SCAN_CACHE_PATH = process.env.SCAN_CACHE
  ? path.resolve(ROOT, process.env.SCAN_CACHE)
  : path.join(DATA, 'orphan-spam-today-scan.json');
const CHECKPOINT_PATH = process.env.CHECKPOINT
  ? path.resolve(ROOT, process.env.CHECKPOINT)
  : path.join(DATA, 'orphan-spam-cleanup-checkpoint.json');
const RESUME = String(process.env.RESUME || '1') === '1';

const FORCE_CONTACT_IDS = [
  'cmrwwb42efm4ptb01rhys1ivb',
  'cmrwvbyej786ftb01zi5kn63v',
  'cmrwwh6jrgupztb0191g4j33q',
];
const FORCE_EMAILS = [
  'evertonftm@hotmail.com',
  'jeniferbarrosilva007@gmail.com',
  'flordeluciana@hotmail.com',
];

const limiter = createRateLimiter(DRY_RATE, 1000);
let reqOk = 0;
let req429 = 0;

function isToday(iso) {
  const t = new Date(iso || 0).getTime();
  return Number.isFinite(t) && t >= TODAY_START.getTime();
}
function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function api(pathname) {
  let attempt = 0;
  while (true) {
    await limiter.acquire();
    let res;
    try {
      res = await fetch(`${API}${pathname}`, {
        headers: { Authorization: `Bearer ${TOKEN}`, Accept: 'application/json' },
      });
    } catch (err) {
      attempt += 1;
      if (attempt > 8) throw err;
      await sleep(250 * attempt);
      continue;
    }
    if (res.status === 429 || res.status >= 500) {
      req429 += 1;
      attempt += 1;
      if (attempt > 10) {
        const e = new Error(`HTTP ${res.status}`);
        e.status = res.status;
        throw e;
      }
      const ra = Number(res.headers.get('retry-after'));
      const wait = Number.isFinite(ra) && ra > 0 ? ra * 1000 : Math.min(8000, 500 * attempt);
      await sleep(wait);
      continue;
    }
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      const e = new Error(`HTTP ${res.status} ${text.slice(0, 100)}`);
      e.status = res.status;
      throw e;
    }
    reqOk += 1;
    return res.json();
  }
}

async function listDealsForContact(contactId) {
  const raw = await api(`/api/deals?contactId=${encodeURIComponent(contactId)}&page=1&perPage=100`);
  return Array.isArray(raw?.items) ? raw.items : [];
}

async function getDeal(id) {
  return api(`/api/deals/${encodeURIComponent(id)}`);
}

function panelFields(detail) {
  return detail?.dealPanelFields || detail?.customFields || [];
}
function panelValue(detail, names) {
  const wanted = names.map((n) => n.toLowerCase());
  for (const f of panelFields(detail)) {
    const name = String(f?.name || f?.label || '').trim().toLowerCase();
    if (wanted.includes(name) && f?.value != null && String(f.value).trim() !== '') {
      return String(f.value).trim();
    }
  }
  return '';
}
function filledCount(detail) {
  return panelFields(detail).filter((f) => f?.value != null && String(f.value).trim() !== '').length;
}

function rankTuple(d) {
  return [
    d.today ? 1 : 0,
    -(d.filled || 0),
    Number(d.number) || 1e15,
    new Date(d.createdAt || 0).getTime() || 1e15,
  ];
}
function cmpRank(a, b) {
  const ra = rankTuple(a);
  const rb = rankTuple(b);
  for (let i = 0; i < ra.length; i++) if (ra[i] !== rb[i]) return ra[i] - rb[i];
  return String(a.id).localeCompare(String(b.id));
}

function planForContact(deals) {
  const byRgm = new Map();
  const empty = [];
  for (const d of deals) {
    const rgm = normalizeRgm(d.rgm) || '';
    if (rgm) {
      if (!byRgm.has(rgm)) byRgm.set(rgm, []);
      byRgm.get(rgm).push(d);
    } else empty.push(d);
  }
  const keep = [];
  const del = [];
  for (const [, group] of byRgm) {
    group.sort(cmpRank);
    keep.push(group[0]);
    del.push(...group.slice(1));
  }
  if (byRgm.size > 0) {
    for (const e of empty) {
      if (e.today) del.push(e);
      else keep.push(e);
    }
  } else {
    empty.sort(cmpRank);
    if (empty.length) keep.push(empty[0]);
    del.push(...empty.slice(1));
  }
  return { keep, delete: del, distinct_rgms: [...byRgm.keys()] };
}

function dealBrief(d) {
  return {
    id: d.id,
    number: d.number,
    title: d.title || null,
    stageId: d.stageId || null,
    createdAt: d.createdAt || null,
    rgm: d.rgm || '',
    today: Boolean(d.today),
    filled: d.filled || 0,
  };
}

async function mapPool(items, concurrency, fn) {
  const out = new Array(items.length);
  let i = 0;
  async function worker() {
    while (i < items.length) {
      const idx = i++;
      out[idx] = await fn(items[idx], idx);
    }
  }
  await Promise.all(
    Array.from({ length: Math.min(concurrency, Math.max(1, items.length)) }, () => worker())
  );
  return out;
}

function toEnriched(detail, fallback = {}) {
  const contact = detail?.contact || fallback.contact || {};
  return {
    id: detail?.id || fallback.id,
    number: detail?.number ?? fallback.number,
    title: detail?.title ?? fallback.title,
    stageId: detail?.stageId ?? fallback.stageId,
    createdAt: detail?.createdAt ?? fallback.createdAt,
    rgm: normalizeRgm(panelValue(detail, ['rgm'])) || '',
    today: isToday(detail?.createdAt ?? fallback.createdAt),
    filled: filledCount(detail),
    email: contact.email || null,
    name: contact.name || detail?.title || fallback.title || null,
  };
}

if (!fs.existsSync(SCAN_CACHE_PATH)) {
  console.error('Missing scan cache:', SCAN_CACHE_PATH, '— run with FORCE_RESCAN first or provide SCAN_CACHE');
  process.exit(1);
}

const cached = JSON.parse(fs.readFileSync(SCAN_CACHE_PATH, 'utf8'));
const todayByContact = new Map(Object.entries(cached.today_by_contact || {}));
for (const id of FORCE_CONTACT_IDS) {
  if (!todayByContact.has(id)) todayByContact.set(id, []);
}

let contactIds = [...todayByContact.keys()].sort((a, b) => {
  const na = todayByContact.get(a)?.length || 0;
  const nb = todayByContact.get(b)?.length || 0;
  const fa = FORCE_CONTACT_IDS.includes(a) ? 1 : 0;
  const fb = FORCE_CONTACT_IDS.includes(b) ? 1 : 0;
  if (fa !== fb) return fb - fa;
  return nb - na;
});

if (ONLY_MULTI_TODAY && !INCLUDE_SINGLES) {
  contactIds = contactIds.filter(
    (id) => FORCE_CONTACT_IDS.includes(id) || (todayByContact.get(id)?.length || 0) >= 2
  );
}

if (MAX_CONTACTS > 0) contactIds = contactIds.slice(0, MAX_CONTACTS);

/** @type {Map<string, object>} */
const donePlans = new Map();
if (RESUME && fs.existsSync(CHECKPOINT_PATH)) {
  try {
    const cp = JSON.parse(fs.readFileSync(CHECKPOINT_PATH, 'utf8'));
    for (const p of cp.contacts || []) donePlans.set(p.contact_id, p);
    console.log(`[resume] loaded checkpoint contacts=${donePlans.size}`);
  } catch (err) {
    console.warn('[resume] checkpoint unreadable', err.message);
  }
}

const pending = contactIds.filter((id) => !donePlans.has(id));
console.log(
  `[orphan-spam-cleanup-dry] rate=${DRY_RATE}/s list_c=${LIST_CONCURRENCY} get_c=${GET_CONCURRENCY} total=${contactIds.length} pending=${pending.length} only_multi=${ONLY_MULTI_TODAY && !INCLUDE_SINGLES}`
);

const t0 = Date.now();
let listed = 0;

// Phase A: list deals for pending contacts
/** @type {Map<string, object[]>} */
const dealsByContact = new Map();
const dealIdToContact = new Map();
const dealFallbacks = new Map();

await mapPool(pending, LIST_CONCURRENCY, async (contactId) => {
  try {
    const items = await listDealsForContact(contactId);
    dealsByContact.set(contactId, items);
    for (const d of items) {
      dealIdToContact.set(d.id, contactId);
      dealFallbacks.set(d.id, d);
    }
  } catch (err) {
    dealsByContact.set(contactId, []);
    console.warn(`[list] ${contactId} ${err.message}`);
  }
  listed += 1;
  if (listed % 100 === 0 || listed === pending.length) {
    const elapsed = (Date.now() - t0) / 1000;
    console.log(
      `[list] ${listed}/${pending.length} deals_ids=${dealFallbacks.size} ok=${reqOk} 429s=${req429} ${elapsed.toFixed(0)}s`
    );
  }
});

// Skip single-deal contacts (nothing to delete)
const needEnrichContacts = [];
for (const contactId of pending) {
  const items = dealsByContact.get(contactId) || [];
  if (items.length <= 1) {
    donePlans.set(contactId, {
      contact_id: contactId,
      email: todayByContact.get(contactId)?.[0]?.email || null,
      name: todayByContact.get(contactId)?.[0]?.name || items[0]?.title || null,
      total_deals: items.length,
      deals_today: items.filter((d) => isToday(d.createdAt)).length,
      distinct_rgms: [],
      keep: items.map((d) =>
        dealBrief({
          id: d.id,
          number: d.number,
          title: d.title,
          stageId: d.stageId,
          createdAt: d.createdAt,
          rgm: '',
          today: isToday(d.createdAt),
          filled: 0,
        })
      ),
      delete: [],
      skipped_single: true,
    });
  } else {
    needEnrichContacts.push(contactId);
  }
}
console.log(`[list] need_enrich_contacts=${needEnrichContacts.length} skipped_single=${pending.length - needEnrichContacts.length}`);

// Phase B: flat getDeal for all deals on need-enrich contacts
const dealIds = [];
for (const contactId of needEnrichContacts) {
  for (const d of dealsByContact.get(contactId) || []) dealIds.push(d.id);
}
console.log(`[get] deals_to_fetch=${dealIds.length}`);

/** @type {Map<string, object>} */
const enrichedById = new Map();
let got = 0;
const tGet = Date.now();

await mapPool(dealIds, GET_CONCURRENCY, async (dealId) => {
  try {
    const detail = await getDeal(dealId);
    enrichedById.set(dealId, toEnriched(detail, dealFallbacks.get(dealId)));
  } catch (err) {
    enrichedById.set(
      dealId,
      toEnriched({ id: dealId }, dealFallbacks.get(dealId) || { id: dealId })
    );
    enrichedById.get(dealId).enrich_error = err.message;
  }
  got += 1;
  if (got % 200 === 0 || got === dealIds.length) {
    const elapsed = (Date.now() - tGet) / 1000;
    const rate = got / Math.max(elapsed, 1);
    const eta = (dealIds.length - got) / Math.max(rate, 0.01) / 60;
    console.log(
      `[get] ${got}/${dealIds.length} rate=${rate.toFixed(1)}/s eta_min=${eta.toFixed(1)} ok=${reqOk} 429s=${req429}`
    );
  }
});

// Phase C: plan
for (const contactId of needEnrichContacts) {
  const items = dealsByContact.get(contactId) || [];
  const enriched = items.map((d) => enrichedById.get(d.id)).filter(Boolean);
  const planned = planForContact(enriched);
  const email = String(
    enriched.find((d) => d.email)?.email || todayByContact.get(contactId)?.[0]?.email || ''
  )
    .trim()
    .toLowerCase();
  const name = String(
    enriched.find((d) => d.name)?.name || enriched[0]?.title || ''
  ).trim();
  donePlans.set(contactId, {
    contact_id: contactId,
    email: email || null,
    name: name || null,
    total_deals: enriched.length,
    deals_today: enriched.filter((d) => d.today).length,
    distinct_rgms: planned.distinct_rgms,
    keep: planned.keep.map(dealBrief),
    delete: planned.delete.map(dealBrief),
  });
}

// checkpoint
const allPlans = contactIds.map((id) => donePlans.get(id)).filter(Boolean);
fs.writeFileSync(
  CHECKPOINT_PATH,
  JSON.stringify(
    {
      updated_at: new Date().toISOString(),
      only_multi_today: ONLY_MULTI_TODAY && !INCLUDE_SINGLES,
      contacts: allPlans,
    },
    null,
    2
  ),
  'utf8'
);

// aggregates
let dealsKeep = 0;
let dealsDelete = 0;
let contactsWithDeletes = 0;
let contactsSkippedSingle = 0;
const contactPlans = [];
const emailToContacts = new Map();

for (const p of allPlans) {
  if (p.skipped_single) contactsSkippedSingle += 1;
  dealsKeep += (p.keep || []).length;
  dealsDelete += (p.delete || []).length;
  if ((p.delete || []).length > 0) contactsWithDeletes += 1;
  if (p.email) {
    if (!emailToContacts.has(p.email)) emailToContacts.set(p.email, []);
    emailToContacts.get(p.email).push(p.contact_id);
  }
  if (
    (p.delete || []).length > 0 ||
    FORCE_CONTACT_IDS.includes(p.contact_id) ||
    FORCE_EMAILS.includes(p.email)
  ) {
    contactPlans.push(p);
  }
}

const flaggedOrphanDups = [];
for (const [email, ids] of emailToContacts) {
  const uniq = [...new Set(ids)];
  if (uniq.length > 1) {
    flaggedOrphanDups.push({
      email,
      contact_ids: uniq,
      note: 'Possible duplicate contacts sharing email — do NOT auto-delete; review later',
    });
  }
}
for (const p of contactPlans) {
  if (p.email && (emailToContacts.get(p.email)?.length || 0) > 1) p.flag_orphan_dup_contact = true;
}

function pickSample(pred) {
  return contactPlans.find(pred) || null;
}
const samples = {
  everton: pickSample(
    (p) =>
      p.email === 'evertonftm@hotmail.com' ||
      p.contact_id === 'cmrwwb42efm4ptb01rhys1ivb' ||
      String(p.name || '').toUpperCase().includes('EVERTON FERNANDO')
  ),
  jenifer: pickSample(
    (p) =>
      p.email === 'jeniferbarrosilva007@gmail.com' ||
      p.contact_id === 'cmrwvbyej786ftb01zi5kn63v' ||
      String(p.name || '').toUpperCase().includes('JENIFER')
  ),
  flor: pickSample(
    (p) =>
      p.email === 'flordeluciana@hotmail.com' ||
      p.contact_id === 'cmrwwh6jrgupztb0191g4j33q' ||
      String(p.name || '').toUpperCase().includes('LUCIANA MARTINS')
  ),
};

const eta = {
  delete_count: dealsDelete,
  rate_per_s_low: 4,
  rate_per_s_high: 6,
  minutes_at_4_per_s: Number((dealsDelete / 4 / 60).toFixed(1)),
  minutes_at_6_per_s: Number((dealsDelete / 6 / 60).toFixed(1)),
  minutes_with_429_backoff_band: {
    low: Number(((dealsDelete / 6 / 60) * 1.15).toFixed(1)),
    high: Number(((dealsDelete / 4 / 60) * 1.4).toFixed(1)),
  },
  note: 'DELETE-only estimate at 4–6/s with 429 backoff; contacts not deleted.',
};

const out = {
  api: API,
  dry_run: true,
  today: TODAY_BRT,
  today_start_utc: TODAY_START.toISOString(),
  generated_at: new Date().toISOString(),
  scan: {
    from_cache: true,
    cache_path: SCAN_CACHE_PATH,
    today_deals_seen: cached.today_deals_seen,
    contacts_with_today_deal: todayByContact.size,
  },
  counts: {
    contacts_scanned: contactIds.length,
    contacts_skipped_single_deal: contactsSkippedSingle,
    contacts_with_deletes: contactsWithDeletes,
    deals_keep: dealsKeep,
    deals_delete: dealsDelete,
    orphan_dup_emails_flagged: flaggedOrphanDups.length,
    only_multi_today: ONLY_MULTI_TODAY && !INCLUDE_SINGLES,
    req_ok: reqOk,
    req_429: req429,
  },
  eta_apply: eta,
  samples,
  flagged_orphan_dup_contacts: flaggedOrphanDups,
  contacts: contactPlans,
};

const outPath = path.join(DATA, `orphan-spam-cleanup-dry-${Date.now()}.json`);
fs.writeFileSync(outPath, JSON.stringify(out, null, 2), 'utf8');

console.log('\n=== DRY-RUN SUMMARY ===');
console.log(JSON.stringify(out.counts, null, 2));
console.log('eta_apply', JSON.stringify(eta, null, 2));
console.log('samples', {
  everton: Boolean(samples.everton),
  jenifer: Boolean(samples.jenifer),
  flor: Boolean(samples.flor),
});
if (samples.everton) {
  console.log('Everton keep#', samples.everton.keep.map((d) => d.number), 'del#', samples.everton.delete.map((d) => d.number));
}
if (samples.jenifer) {
  console.log(
    'Jenifer keep#',
    samples.jenifer.keep.map((d) => `${d.number}:${d.rgm || '∅'}`),
    'del',
    samples.jenifer.delete.length
  );
}
if (samples.flor) {
  console.log('Flor keep#', samples.flor.keep.map((d) => d.number), 'del#', samples.flor.delete.map((d) => d.number));
}
console.log('wrote', outPath);
console.log('checkpoint', CHECKPOINT_PATH);
