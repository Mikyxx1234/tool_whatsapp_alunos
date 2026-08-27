/**
 * Multi-dup cleanup (Naionara-class): open deals by CPF >> SIAA distinct RGMs.
 *
 * Soft-safety:
 *   node scripts/novo-crm-multi-dup-cleanup.mjs              → dry-run only
 *   node scripts/novo-crm-multi-dup-cleanup.mjs --apply      → DELETE clones
 *
 * Keep: 1 deal per SIAA RGM (prefer correct RGM+curso on deal; oldest
 * good title matching SIAA name; Grad/Pós by nivel when available).
 * Never Perdido — hard DELETE via DELETE /api/deals/:id.
 *
 * Env: ONLY_CPF=33559094836  MAX_DELETE=0  DRY_RATE=4  FORCE_CONTACT=
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import {
  normalizeCpf,
  normalizeRgm,
} from '../server/utils/novoCrmCacheNormalize.js';
import { extractMatriculadosMappedValues } from '../server/utils/novoCrmFieldMapping.js';
import * as baseUploadRepo from '../server/repositories/baseUploadRepository.js';
import * as client from '../server/services/novoCrmClient.js';
import { createRateLimiter } from '../server/utils/rateLimiter.js';
import { getNovoCrmStageIds } from '../server/utils/novoCrmStageRules.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const DATA = path.join(ROOT, 'data');

try {
  const dotenv = await import('dotenv');
  dotenv.config({ path: path.join(ROOT, '.env'), override: false });
} catch {
  /* optional */
}

const APPLY = process.argv.includes('--apply');
const ONLY_CPF = normalizeCpf(process.env.ONLY_CPF || '');
/** Force live plan for these CPFs (Naionara always). */
const FORCE_CPFS = new Set(
  [...(ONLY_CPF ? [ONLY_CPF] : ['33559094836'])].map(normalizeCpf).filter(Boolean)
);
const MAX_DELETE = Math.max(0, Number(process.env.MAX_DELETE) || 0);
const DRY_RATE = Math.max(1, Math.min(12, Number(process.env.DRY_RATE) || 6));
const EXCESS_MIN = Math.max(1, Number(process.env.EXCESS_MIN) || 1);
/** Live-enrich only the worst offenders (+ force). Cache flags the rest. */
const LIVE_MAX = Math.max(0, Number(process.env.LIVE_MAX) || 40);
const LIVE_EXCESS_MIN = Math.max(1, Number(process.env.LIVE_EXCESS_MIN) || 3);
const REQUIRE_NAME_MATCH = String(process.env.REQUIRE_NAME_MATCH || '1') !== '0';
const EM_ATENDIMENTO = String(
  process.env.NOVO_CRM_STAGE_EM_ATENDIMENTO || 'cmrxn1r190v2vo101kaqh4cup'
).trim();
const PERDIDO = String(
  process.env.NOVO_CRM_STAGE_PERDIDO || 'cmrwd5vuo014hpd01imhgkp0y'
).trim();
const GANHO = String(process.env.NOVO_CRM_STAGE_GANHO || '').trim();

const API = String(process.env.NOVO_CRM_API_BASE_URL || '').trim().replace(/\/$/, '');
const TOKEN = String(process.env.NOVO_CRM_API_TOKEN || '').trim();
if (!API || !TOKEN) {
  console.error('Missing NOVO_CRM_API_BASE_URL / NOVO_CRM_API_TOKEN');
  process.exit(1);
}
if (APPLY && !/crm\.eduit\.com\.br|cruzeiro-ead\.bwipo\.com/i.test(API)) {
  console.error('Refusing apply: API host is not PROD →', API);
  process.exit(1);
}

const limiter = createRateLimiter(DRY_RATE, 1000);
function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function withLimit(fn) {
  await limiter.acquire();
  return fn();
}

function panelValue(detail, names) {
  const wanted = names.map((n) => n.toLowerCase());
  const fields = detail?.dealPanelFields || detail?.customFields || [];
  for (const f of fields) {
    const name = String(f?.name || f?.label || '')
      .trim()
      .toLowerCase();
    if (wanted.includes(name) && f?.value != null && String(f.value).trim() !== '') {
      let v = f.value;
      if (typeof v === 'object') v = v.value ?? JSON.stringify(v);
      return String(v).trim();
    }
  }
  return '';
}

function filledCount(detail) {
  const fields = detail?.dealPanelFields || detail?.customFields || [];
  return fields.filter((f) => f?.value != null && String(f.value).trim() !== '').length;
}

function isPosNivel(s) {
  const t = String(s || '')
    .toUpperCase()
    .normalize('NFD')
    .replace(/\p{M}/gu, '');
  return t.includes('POS') || t.includes('ESPECIALIZ');
}

function isGradNivel(s) {
  const t = String(s || '')
    .toUpperCase()
    .normalize('NFD')
    .replace(/\p{M}/gu, '');
  return t.includes('GRAD') || t.includes('BACH') || t.includes('LICENC');
}

function nameTokens(s) {
  return String(s || '')
    .toUpperCase()
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .replace(/[^A-Z\s]/g, ' ')
    .split(/\s+/)
    .filter((t) => t.length >= 3 && !['NEGOCIO', 'LEAD', 'DOC', 'DE', 'DA', 'DO', 'DOS', 'DAS', 'E'].includes(t));
}

/** Same person if ≥2 name tokens overlap (or single unique surname match on long tokens). */
function namesPlausiblyMatch(a, b) {
  const ta = nameTokens(a);
  const tb = nameTokens(b);
  if (!ta.length || !tb.length) return false;
  let hit = 0;
  const setB = new Set(tb);
  for (const t of ta) if (setB.has(t)) hit += 1;
  if (hit >= 2) return true;
  if (hit === 1 && ta.some((t) => t.length >= 6 && setB.has(t))) return true;
  return false;
}

/** Safe to hard-delete this card for the CPF cluster. */
function okToDeleteClone(d, keepList, canonicalName) {
  if (!REQUIRE_NAME_MATCH) return true;
  const title = String(d.title || '');
  if (/^(neg[oó]cio|lead)\b/i.test(title.trim())) return true;
  if (canonicalName && namesPlausiblyMatch(title, canonicalName)) return true;
  if (keepList.some((k) => namesPlausiblyMatch(title, k.title))) return true;
  // Keep tem o nome SIAA, este título é lixo/outra pessoa no mesmo CPF → DELETE
  if (
    canonicalName &&
    keepList.some((k) => namesPlausiblyMatch(k.title, canonicalName)) &&
    !namesPlausiblyMatch(title, canonicalName)
  ) {
    return true;
  }
  return false;
}

/** Prefer keep ranking (lower better). */
function keepRank(d, siaaByRgm, canonicalName) {
  const rgmOk = d.rgm && siaaByRgm.has(d.rgm) ? 0 : 1;
  const title = String(d.title || '').toUpperCase();
  const nameHit =
    canonicalName && title.includes(canonicalName.slice(0, 8).toUpperCase()) ? 0 : 1;
  const franc = title.includes('FRANCILAINE') ? 1 : 0;
  const filled = -(d.filled || 0);
  const age = new Date(d.createdAt || 0).getTime() || 1e15;
  const emAtend = d.stageId === EM_ATENDIMENTO ? -1 : 0; // keep em atendimento if must
  return [franc, rgmOk, nameHit, emAtend, filled, age, Number(d.number) || 1e15];
}

function cmpKeep(a, b, siaaByRgm, name) {
  const ra = keepRank(a, siaaByRgm, name);
  const rb = keepRank(b, siaaByRgm, name);
  for (let i = 0; i < ra.length; i++) {
    if (ra[i] !== rb[i]) return ra[i] - rb[i];
  }
  return 0;
}

/**
 * Pick keep set: ideally 1 deal per SIAA RGM.
 * If no deal has a given RGM, keep best empty-RGM card (or recycle a same-RGM
 * excess clone) and plan field rebuild for that SIAA RGM.
 */
function planKeeps(deals, siaaRgms, siaaByRgm, canonicalName) {
  const keep = [];
  const deleteList = [];
  const rebuild = []; // { dealId, rgm, row, number }
  const used = new Set();
  /** Spares after first keep per RGM — may be recycled for missing RGMs. */
  const spares = [];

  for (const rgm of siaaRgms) {
    const candidates = deals
      .filter((d) => !used.has(d.id) && d.rgm === rgm)
      .sort((a, b) => cmpKeep(a, b, siaaByRgm, canonicalName));
    if (candidates.length) {
      const named = candidates.filter(
        (c) =>
          !canonicalName ||
          namesPlausiblyMatch(c.title, canonicalName) ||
          /^(neg[oó]cio|lead)\b/i.test(c.title || '')
      );
      const pickPool = named.length
        ? named.sort((a, b) => cmpKeep(a, b, siaaByRgm, canonicalName))
        : candidates;
      keep.push(pickPool[0]);
      used.add(pickPool[0].id);
      for (const extra of candidates) {
        if (used.has(extra.id)) continue;
        used.add(extra.id);
        spares.push(extra);
      }
      continue;
    }
    // no deal with this RGM — try empty RGM deal to repurpose
    const empty = deals
      .filter((d) => !used.has(d.id) && !d.rgm)
      .sort((a, b) => cmpKeep(a, b, siaaByRgm, canonicalName));
    if (empty.length) {
      keep.push(empty[0]);
      used.add(empty[0].id);
      rebuild.push({
        dealId: empty[0].id,
        rgm,
        row: siaaByRgm.get(rgm),
        number: empty[0].number,
      });
    }
  }

  // Recycle excess clones so we still have 1 body per SIAA RGM (multi-curso)
  for (const rgm of siaaRgms) {
    const covered = new Set([
      ...keep.map((k) => k.rgm).filter(Boolean),
      ...rebuild.map((x) => x.rgm),
    ]);
    if (covered.has(rgm)) continue;
    // prefer spare that matches SIAA name
    spares.sort((a, b) => cmpKeep(a, b, siaaByRgm, canonicalName));
    // spares are already marked used - pick from spares not yet in keep
    const keepIds = new Set(keep.map((k) => k.id));
    const spare = spares.find((s) => !keepIds.has(s.id));
    if (!spare) {
      // last chance: any remaining deal
      const rem = deals.find((d) => !keepIds.has(d.id));
      if (!rem) continue;
      keep.push(rem);
      rebuild.push({ dealId: rem.id, rgm, row: siaaByRgm.get(rgm), number: rem.number });
      used.add(rem.id);
      continue;
    }
    keep.push(spare);
    rebuild.push({
      dealId: spare.id,
      rgm,
      row: siaaByRgm.get(rgm),
      number: spare.number,
    });
  }

  const keepIds = new Set(keep.map((k) => k.id));
  for (const d of deals) {
    if (keepIds.has(d.id)) continue;
    if (!okToDeleteClone(d, keep, canonicalName)) {
      deleteList.push({ ...d, reason: 'skipped_name_mismatch' });
      continue;
    }
    deleteList.push({
      ...d,
      reason: d.rgm && keep.some((k) => k.rgm === d.rgm) ? 'same_rgm_spam' : 'excess_open',
    });
  }

  const realDelete = deleteList.filter((d) => d.reason !== 'skipped_name_mismatch');
  const skippedName = deleteList.filter((d) => d.reason === 'skipped_name_mismatch');
  return { keep, delete: realDelete, rebuild, skippedName };
}

// ── SIAA index ──────────────────────────────────────────────
console.log('[multi-dup] loading latest matriculados…');
const matSnap = await baseUploadRepo.getLatestSnapshot('matriculados');
if (!matSnap?.id) {
  console.error('No matriculados snapshot');
  process.exit(1);
}
/** @type {Map<string, Map<string, object>>} cpf → rgm → mapped row */
const siaaByCpf = new Map();
await baseUploadRepo.forEachRowDataForSnapshot('matriculados', matSnap.id, (row) => {
  const m = extractMatriculadosMappedValues(row);
  const cpf = normalizeCpf(m.cpf);
  const rgm = normalizeRgm(m.rgm);
  if (!cpf || !rgm) return;
  let g = siaaByCpf.get(cpf);
  if (!g) {
    g = new Map();
    siaaByCpf.set(cpf, g);
  }
  // prefer EM CURSO
  const prev = g.get(rgm);
  if (!prev) g.set(rgm, { row, mapped: m });
  else {
    const ps = String(prev.mapped.situacao || '').toUpperCase();
    const cs = String(m.situacao || '').toUpperCase();
    if (cs.includes('CURSO') && !ps.includes('CURSO')) g.set(rgm, { row, mapped: m });
  }
});
console.log(`[multi-dup] SIAA persons=${siaaByCpf.size} snap=${matSnap.id}`);

// ── Local person cache: group open deals by CPF ─────────────
const appPool = new pg.Pool({ connectionString: process.env.DATABASE_URL, ssl: false });
const { rows: cacheRows } = await appPool.query(`
  SELECT contact_id, nome, cpf_norm, rgm_norm, primary_deal_id, raw_data
  FROM novo_crm_person_cache
  WHERE is_deleted = false
`);
await appPool.end();

/** cpf → { contactIds:Set, deals:[{id,number,title,stageId,contactId,rgm,curso,createdAt}] } */
const clusters = new Map();

function ensureCluster(cpf) {
  let c = clusters.get(cpf);
  if (!c) {
    c = { cpf, contactIds: new Set(), deals: [] };
    clusters.set(cpf, c);
  }
  return c;
}

function dealFields(deal) {
  const map = {};
  for (const f of deal?.customFields || []) {
    const n = String(f?.name || '')
      .trim()
      .toLowerCase();
    if (n && f?.value != null) map[n] = String(f.value).trim();
  }
  return map;
}

for (const row of cacheRows) {
  const deals = row.raw_data?.dealsById
    ? Object.values(row.raw_data.dealsById)
    : row.raw_data?.deals || [];
  const list = Array.isArray(deals) ? deals : [];
  for (const d of list) {
    if (!d?.id) continue;
    const stageId = String(d.stageId || d.stage?.id || '').trim();
    // skip closed-ish
    if (PERDIDO && stageId === PERDIDO) continue;
    if (GANHO && stageId === GANHO) continue;
    const cf = dealFields(d);
    const cpf =
      normalizeCpf(cf.cpf || cf.documento || cf.taxid) ||
      normalizeCpf(row.cpf_norm);
    if (!cpf) continue;
    if (ONLY_CPF && cpf !== ONLY_CPF) continue;
    const cl = ensureCluster(cpf);
    cl.contactIds.add(row.contact_id);
    if (cl.deals.some((x) => x.id === d.id)) continue;
    cl.deals.push({
      id: String(d.id),
      number: d.number ?? null,
      title: d.title || '',
      stageId,
      stageName: d.stage?.name || '',
      contactId: row.contact_id,
      rgm: normalizeRgm(cf.rgm || row.rgm_norm),
      curso: cf.curso || '',
      nivel: cf.nível || cf.nivel || '',
      createdAt: d.createdAt || null,
      status: d.status || null,
      fromCache: true,
    });
  }
  // also denorm cpf without deals list?
  const cpfSolo = normalizeCpf(row.cpf_norm);
  if (cpfSolo && (!ONLY_CPF || cpfSolo === ONLY_CPF)) {
    ensureCluster(cpfSolo).contactIds.add(row.contact_id);
  }
}

// Force Naionara + any ONLY_CPF even if cache incomplete → live search
const forceList = [...FORCE_CPFS];
console.log(`[multi-dup] cache clusters=${clusters.size} force_cpfs=${forceList.join(',')}`);

async function liveEnrichCluster(cpf) {
  const siaa = siaaByCpf.get(cpf);
  if (!siaa) return null;
  // search by CPF
  let contactIds = new Set(clusters.get(cpf)?.contactIds || []);
  try {
    const sc = await withLimit(() => client.searchContacts(cpf));
    for (const c of sc.items || []) {
      if (c?.id) contactIds.add(c.id);
    }
  } catch (err) {
    console.warn('[multi-dup] searchContacts', cpf, err.message);
  }
  // also search by each RGM
  for (const rgm of siaa.keys()) {
    try {
      const sc = await withLimit(() => client.searchContacts(rgm));
      for (const c of sc.items || []) if (c?.id) contactIds.add(c.id);
    } catch {
      /* ignore */
    }
  }

  const deals = [];
  const seen = new Set();
  for (const cid of contactIds) {
    let page;
    try {
      page = await withLimit(() =>
        client.listDealsPage({ contactId: cid, page: 1, perPage: 100 })
      );
    } catch (err) {
      console.warn('[multi-dup] listDeals', cid, err.message);
      continue;
    }
    for (const d of page.items || []) {
      if (!d?.id || seen.has(d.id)) continue;
      const stageId = String(d.stageId || d.stage?.id || '').trim();
      if (PERDIDO && stageId === PERDIDO) continue;
      if (GANHO && stageId === GANHO) continue;
      let detail = d;
      try {
        detail = (await withLimit(() => client.getDeal(d.id))) || d;
      } catch {
        detail = d;
      }
      const rgm = normalizeRgm(panelValue(detail, ['rgm']));
      const cpfD = normalizeCpf(panelValue(detail, ['cpf', 'documento', 'taxid']));
      // Strict: only deals that carry this CPF (empty CPF → skip — RGM search
      // can surface contacts/deals of outras pessoas com RGM poluído).
      if (cpfD !== cpf) continue;
      seen.add(d.id);
      deals.push({
        id: String(d.id),
        number: detail.number ?? d.number ?? null,
        title: detail.title || d.title || '',
        stageId,
        stageName: detail.stage?.name || d.stage?.name || '',
        contactId: cid,
        rgm,
        curso: panelValue(detail, ['curso']),
        nivel: panelValue(detail, ['nível', 'nivel']),
        createdAt: detail.createdAt || d.createdAt || null,
        filled: filledCount(detail),
        status: detail.status || d.status || null,
        fromLive: true,
      });
      await sleep(40);
    }
  }
  return { cpf, contactIds, deals, siaa };
}

// Scan: flag excess
const flagged = [];
for (const [cpf, cl] of clusters) {
  const siaa = siaaByCpf.get(cpf);
  if (!siaa) continue;
  const siaaCount = siaa.size;
  const open = cl.deals.length;
  const excess = open - siaaCount;
  const multi = siaaCount > 1;
  // same RGM spam OR multi excess
  const byRgm = new Map();
  for (const d of cl.deals) {
    const k = d.rgm || '(empty)';
    byRgm.set(k, (byRgm.get(k) || 0) + 1);
  }
  const sameRgmSpam = [...byRgm.values()].some((n) => n > 1);
  if (excess >= EXCESS_MIN && (multi || sameRgmSpam || open > siaaCount + 0)) {
    if (open > siaaCount) {
      flagged.push({
        cpf,
        open,
        siaaCount,
        excess,
        multi,
        sameRgmSpam,
        rgms_siaa: [...siaa.keys()],
        rgms_deals: [...byRgm.entries()],
        contactIds: [...cl.contactIds],
        deal_numbers: cl.deals.map((d) => d.number),
      });
    }
  }
}

// Always force live for Naionara class + top excess
const plans = [];
const flaggedSorted = [...flagged].sort((a, b) => b.excess - a.excess || b.open - a.open);
const liveTargets = new Set(forceList);
for (const f of flaggedSorted) {
  if (liveTargets.size >= LIVE_MAX + forceList.length) break;
  if (f.excess >= LIVE_EXCESS_MIN || (f.multi && f.excess >= 2) || forceList.includes(f.cpf)) {
    liveTargets.add(f.cpf);
  }
}
// if ONLY_CPF, only that
const targetCpfs = ONLY_CPF ? new Set([ONLY_CPF]) : liveTargets;

console.log(
  `[multi-dup] flagged_cache=${flagged.length} live_targets=${targetCpfs.size} mode=${APPLY ? 'APPLY' : 'DRY'}`
);

const FIELD_IDS = {
  cpf: process.env.NOVO_CRM_FIELD_CPF || 'cmrnpd33ekm5snm01jecpmevp',
  rgm: process.env.NOVO_CRM_FIELD_RGM || 'cmrmexurt18tfnm01e6krzug6',
  curso: process.env.NOVO_CRM_FIELD_CURSO || 'cmrmextum18srnm0168l8c9al',
  polo: process.env.NOVO_CRM_FIELD_POLO || 'cmrmexun518tbnm0187ow3aso',
  situacao: process.env.NOVO_CRM_FIELD_SITUACAO || 'cmrmexuw818tjnm01igvkevn1',
  nivel: process.env.NOVO_CRM_FIELD_NIVEL || 'cmrmexul518t9nm01j7qd6gqx',
  atualizado: process.env.NOVO_CRM_FIELD_ATUALIZADO || 'cms9c1gfk0sl0jq011ywjyxfo',
};

for (const cpf of targetCpfs) {
  const live = await liveEnrichCluster(cpf);
  if (!live || !live.deals.length) {
    console.log(`[multi-dup] skip cpf=${cpf} no live deals`);
    continue;
  }
  const siaaRgms = [...live.siaa.keys()];
  const siaaByRgm = new Map(
    [...live.siaa.entries()].map(([r, v]) => [r, v.mapped || v.row])
  );
  const name =
    live.siaa.values().next().value?.mapped?._nome_full ||
    live.deals.find((d) => /NAIONARA/i.test(d.title))?.title ||
    '';
  // Soft: don't delete the only Em Atendimento if it's the sole good
  const openDeals = live.deals.filter((d) => d.stageId !== PERDIDO);
  if (openDeals.length <= siaaRgms.length) {
    // still check same-RGM spam when multi=1 and 2+ same rgm
    const byR = new Map();
    for (const d of openDeals) byR.set(d.rgm || '(e)', (byR.get(d.rgm || '(e)') || 0) + 1);
    if (![...byR.values()].some((n) => n > 1) && openDeals.length <= siaaRgms.length) {
      console.log(
        `[multi-dup] ok cpf=${cpf} open=${openDeals.length} siaa=${siaaRgms.length} (no excess)`
      );
      continue;
    }
  }
  const plan = planKeeps(openDeals, siaaRgms, siaaByRgm, name);
  // Guard Em Atendimento: if only keep would delete EA and EA is unique good, swap
  for (const d of [...plan.delete]) {
    if (d.stageId === EM_ATENDIMENTO) {
      // if this is the only EA and keep has others, keep EA instead of a weaker keep of same rgm?
      const keepSame = plan.keep.find((k) => k.rgm && k.rgm === d.rgm);
      if (!keepSame || keepSame.id === d.id) {
        // move to keep, remove from delete
        plan.delete = plan.delete.filter((x) => x.id !== d.id);
        if (!plan.keep.some((k) => k.id === d.id)) plan.keep.push(d);
      }
    }
  }
  // Prefer Grad deal with NAIONARA title over FRACILAIN
  plans.push({
    cpf,
    name,
    siaa_rgms: siaaRgms,
    siaa_detail: siaaRgms.map((r) => {
      const m = live.siaa.get(r)?.mapped || {};
      return {
        rgm: r,
        curso: m.curso || '',
        nivel: m.nivel || '',
        situacao: m.situacao || '',
        pos: isPosNivel(m.nivel || m.curso),
        grad: isGradNivel(m.nivel || m.curso),
      };
    }),
    open: openDeals.length,
    keep: plan.keep.map((d) => ({
      id: d.id,
      number: d.number,
      title: d.title,
      rgm: d.rgm,
      curso: d.curso,
      stage: d.stageName,
      stageId: d.stageId,
    })),
    delete: plan.delete.map((d) => ({
      id: d.id,
      number: d.number,
      title: d.title,
      rgm: d.rgm,
      curso: d.curso,
      stage: d.stageName,
      stageId: d.stageId,
      reason: d.reason,
    })),
    skipped_name: (plan.skippedName || []).map((d) => ({
      id: d.id,
      number: d.number,
      title: d.title,
      rgm: d.rgm,
    })),
    rebuild: plan.rebuild,
  });
  console.log(
    `[multi-dup] CPF ${cpf} open=${openDeals.length} siaa=${siaaRgms.length} keep=${plan.keep.length} del=${plan.delete.length} rebuild=${plan.rebuild.length} name_skip=${(plan.skippedName || []).length}`
  );
  for (const k of plan.keep) {
    console.log(`  KEEP #${k.number} rgm=${k.rgm || '∅'} ${String(k.title).slice(0, 40)} ${k.stageName || k.stageId}`);
  }
  for (const d of plan.delete) {
    console.log(`  DEL  #${d.number} rgm=${d.rgm || '∅'} ${String(d.title).slice(0, 40)} ${d.reason}`);
  }
}

const stamp = Date.now();
const dryPath = path.join(DATA, `multi-dup-cleanup-dry-${stamp}.json`);
const summary = {
  dry_run: !APPLY,
  api: API,
  matriculados_snapshot_id: matSnap.id,
  scanned_at: new Date().toISOString(),
  flagged_from_cache: flagged.length,
  flagged_cache_samples: flagged.slice(0, 40),
  plans,
  totals: {
    clusters: plans.length,
    keep: plans.reduce((s, p) => s + p.keep.length, 0),
    delete: plans.reduce((s, p) => s + p.delete.length, 0),
    rebuild: plans.reduce((s, p) => s + p.rebuild.length, 0),
  },
};
fs.writeFileSync(dryPath, JSON.stringify(summary, null, 2));
console.log(`[multi-dup] wrote ${dryPath}`);
console.log('[multi-dup] totals', summary.totals);

if (!APPLY) {
  console.log('[multi-dup] DRY complete — re-run with --apply to DELETE');
  process.exit(0);
}

// ── APPLY: rebuild fields then DELETE ───────────────────────
const stageIds = getNovoCrmStageIds();
let rebuildOk = 0;
let rebuildErr = 0;
let deleted = 0;
let alreadyGone = 0;
let delErr = 0;
const delErrors = [];
let reget404 = 0;

for (const p of plans) {
  for (const r of p.rebuild || []) {
    if (!r.dealId || !r.rgm) continue;
    const mapped = r.row || {};
    const m =
      mapped.curso != null || mapped.nivel != null
        ? mapped
        : extractMatriculadosMappedValues(mapped) || mapped;
    const values = [
      { fieldId: FIELD_IDS.cpf, value: p.cpf },
      { fieldId: FIELD_IDS.rgm, value: r.rgm },
      m.curso ? { fieldId: FIELD_IDS.curso, value: m.curso } : null,
      m.polo ? { fieldId: FIELD_IDS.polo, value: m.polo } : null,
      m.nivel ? { fieldId: FIELD_IDS.nivel, value: m.nivel } : null,
      m.situacao
        ? { fieldId: FIELD_IDS.situacao, value: String(m.situacao) }
        : null,
      { fieldId: FIELD_IDS.atualizado, value: 'Sim' },
    ].filter(Boolean);
    try {
      await withLimit(() => client.updateDealCustomFields(r.dealId, values, { maxRetries: 4 }));
      const pos = isPosNivel(m.nivel || m.curso);
      const grad = isGradNivel(m.nivel || m.curso);
      const targetStage = pos
        ? stageIds['Pós']
        : grad
          ? stageIds['Graduação']
          : '';
      if (targetStage) {
        try {
          await withLimit(() => client.updateDeal(r.dealId, { stageId: targetStage }));
        } catch (stErr) {
          console.warn(`[apply] stage rebuild ${r.dealId}`, stErr.message);
        }
      }
      rebuildOk += 1;
      console.log(
        `[apply] rebuild #${r.number || r.dealId} → RGM ${r.rgm} stage=${pos ? 'Pós' : grad ? 'Grad' : '?'}`
      );
    } catch (err) {
      rebuildErr += 1;
      console.warn(`[apply] rebuild fail ${r.dealId}`, err.message);
    }
    await sleep(120);
  }
}

let delIds = plans.flatMap((p) => p.delete.map((d) => d.id));
delIds = [...new Set(delIds)];
// never delete keep
const keepIds = new Set(plans.flatMap((p) => p.keep.map((k) => k.id)));
delIds = delIds.filter((id) => !keepIds.has(id));
if (MAX_DELETE > 0) delIds = delIds.slice(0, MAX_DELETE);

console.log(`[apply] DELETE n=${delIds.length} rebuild_ok=${rebuildOk} rebuild_err=${rebuildErr}`);

for (const id of delIds) {
  try {
    await withLimit(() => client.deleteDeal(id));
    deleted += 1;
    // re-GET expect 404
    try {
      await withLimit(() => client.getDeal(id));
      console.warn(`[apply] re-GET still alive ${id}`);
    } catch (err) {
      if (String(err.message || err).includes('404') || err.status === 404) {
        reget404 += 1;
      } else {
        // other = maybe ok deleted
        reget404 += 1;
      }
    }
  } catch (err) {
    if (err.status === 404 || /404/.test(String(err.message))) {
      alreadyGone += 1;
    } else {
      delErr += 1;
      if (delErrors.length < 30) delErrors.push({ id, error: err.message });
    }
  }
  if ((deleted + alreadyGone + delErr) % 10 === 0) {
    console.log(
      `[apply] progress del=${deleted} gone=${alreadyGone} err=${delErr} reget404=${reget404}`
    );
  }
  await sleep(80);
}

const resultPath = path.join(DATA, `multi-dup-cleanup-apply-${stamp}.json`);
const result = {
  dry_json: dryPath,
  applied_at: new Date().toISOString(),
  rebuild_ok: rebuildOk,
  rebuild_err: rebuildErr,
  deleted,
  already_gone: alreadyGone,
  delete_errors: delErr,
  reget_404: reget404,
  del_ids: delIds,
  error_samples: delErrors,
  plans_summary: plans.map((p) => ({
    cpf: p.cpf,
    keep_numbers: p.keep.map((k) => k.number),
    del_numbers: p.delete.map((d) => d.number),
  })),
};
fs.writeFileSync(resultPath, JSON.stringify(result, null, 2));
console.log('[apply] DONE', resultPath, {
  deleted,
  alreadyGone,
  delErr,
  rebuildOk,
});
process.exit(delErr > 0 ? 2 : 0);
