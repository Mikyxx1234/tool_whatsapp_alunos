/**
 * APPLY: delete deals marked in orphan-spam-cleanup-dry-*.json (PROD).
 * Only deletes deal IDs from plan.delete — never keep deals, never contacts.
 *
 * Usage:
 *   DRY_JSON=data/orphan-spam-cleanup-dry-XXXX.json DRY_RATE=5 node scripts/novo-crm-orphan-spam-cleanup-apply.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRateLimiter } from '../server/utils/rateLimiter.js';

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
const DRY_JSON = process.env.DRY_JSON
  ? path.resolve(ROOT, process.env.DRY_JSON)
  : '';
const DRY_RATE = Math.max(1, Math.min(12, Number(process.env.DRY_RATE) || 5));
const CONCURRENCY = Math.min(Math.max(Number(process.env.DEL_CONCURRENCY) || 4, 1), 8);
const MAX_DELETE = Math.max(0, Number(process.env.MAX_DELETE) || 0); // 0 = all

if (!API || !TOKEN) {
  console.error('Missing NOVO_CRM_API_BASE_URL / NOVO_CRM_API_TOKEN');
  process.exit(1);
}
if (!DRY_JSON || !fs.existsSync(DRY_JSON)) {
  console.error('DRY_JSON missing or not found:', DRY_JSON);
  process.exit(1);
}
if (!/crm\.eduit\.com\.br|cruzeiro-ead\.bwipo\.com/i.test(API)) {
  console.error('Refusing apply: API host is not PROD →', API);
  process.exit(1);
}

const plan = JSON.parse(fs.readFileSync(DRY_JSON, 'utf8'));
if (plan.dry_run !== true) {
  console.error('Refusing: JSON dry_run !== true');
  process.exit(1);
}

const keepIds = new Set();
const deleteEntries = [];
for (const c of plan.contacts || []) {
  for (const d of c.keep || []) {
    if (d?.id) keepIds.add(String(d.id));
  }
  for (const d of c.delete || []) {
    if (!d?.id) continue;
    deleteEntries.push({
      deal_id: String(d.id),
      number: d.number ?? null,
      contact_id: c.contact_id || null,
      email: c.email || null,
      rgm: d.rgm || '',
    });
  }
}

// Safety: never delete a keep id
const toDelete = deleteEntries.filter((e) => !keepIds.has(e.deal_id));
const blockedKeep = deleteEntries.length - toDelete.length;
const uniqueIds = [...new Set(toDelete.map((e) => e.deal_id))];
const finalList = MAX_DELETE > 0 ? uniqueIds.slice(0, MAX_DELETE) : uniqueIds;

if (finalList.length === 0) {
  console.error('No delete deal IDs in plan — abort');
  process.exit(1);
}

const stamp = Date.now();
const logPath = path.join(DATA, `orphan-spam-cleanup-apply-${stamp}.log`);
const resultPath = path.join(DATA, `orphan-spam-cleanup-apply-${stamp}.json`);
const logStream = fs.createWriteStream(logPath, { flags: 'a' });

function log(line) {
  const s = `[${new Date().toISOString()}] ${line}`;
  console.log(s);
  logStream.write(s + '\n');
}

const limiter = createRateLimiter(DRY_RATE, 1000);

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function deleteDeal(dealId) {
  let attempt = 0;
  while (true) {
    await limiter.acquire();
    let res;
    try {
      res = await fetch(`${API}/api/deals/${encodeURIComponent(dealId)}`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${TOKEN}`, Accept: 'application/json' },
      });
    } catch (err) {
      attempt += 1;
      if (attempt > 8) throw err;
      await sleep(300 * attempt);
      continue;
    }
    if (res.status === 404) {
      return { ok: true, status: 404, already_gone: true };
    }
    if (res.status === 429 || res.status >= 500) {
      attempt += 1;
      if (attempt > 12) {
        const text = await res.text().catch(() => '');
        const e = new Error(`HTTP ${res.status} ${text.slice(0, 120)}`);
        e.status = res.status;
        throw e;
      }
      const ra = Number(res.headers.get('retry-after'));
      await sleep(Number.isFinite(ra) && ra > 0 ? ra * 1000 : Math.min(10000, 600 * attempt));
      continue;
    }
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      const e = new Error(`HTTP ${res.status} ${text.slice(0, 120)}`);
      e.status = res.status;
      throw e;
    }
    return { ok: true, status: res.status };
  }
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

log(`APPLY START api=${API} dry_json=${DRY_JSON}`);
log(
  `plan keep=${keepIds.size} delete_entries=${deleteEntries.length} unique_del=${uniqueIds.length} blocked_keep_overlap=${blockedKeep} to_delete=${finalList.length} rate=${DRY_RATE}/s conc=${CONCURRENCY}`
);
log(
  `ETA ~${(finalList.length / DRY_RATE / 60).toFixed(1)} min @ ${DRY_RATE}/s (plus 429 backoff)`
);

let deleted = 0;
let alreadyGone = 0;
let errors = 0;
const errorSamples = [];
const t0 = Date.now();
let done = 0;

await mapPool(finalList, CONCURRENCY, async (dealId) => {
  try {
    const r = await deleteDeal(dealId);
    if (r.already_gone) alreadyGone += 1;
    else deleted += 1;
  } catch (err) {
    errors += 1;
    if (errorSamples.length < 40) {
      errorSamples.push({ deal_id: dealId, error: err.message || String(err) });
    }
  }
  done += 1;
  if (done % 100 === 0 || done === finalList.length) {
    const elapsed = (Date.now() - t0) / 1000;
    const rate = done / Math.max(elapsed, 1);
    const etaMin = ((finalList.length - done) / Math.max(rate, 0.01) / 60).toFixed(1);
    log(
      `PROGRESS ${done}/${finalList.length} deleted=${deleted} gone=${alreadyGone} errors=${errors} rate=${rate.toFixed(2)}/s eta_min=${etaMin}`
    );
  }
});

const result = {
  api: API,
  dry_json: DRY_JSON,
  started_at: new Date(t0).toISOString(),
  finished_at: new Date().toISOString(),
  elapsed_sec: Number(((Date.now() - t0) / 1000).toFixed(1)),
  requested: finalList.length,
  deleted,
  already_gone: alreadyGone,
  errors,
  blocked_keep_overlap: blockedKeep,
  error_samples: errorSamples,
  log_path: logPath,
};

fs.writeFileSync(resultPath, JSON.stringify(result, null, 2), 'utf8');
log(`APPLY DONE deleted=${deleted} already_gone=${alreadyGone} errors=${errors}`);
log(`result ${resultPath}`);
logStream.end();

console.log(JSON.stringify(result, null, 2));
process.exit(errors > 0 && deleted === 0 ? 1 : 0);
