/**
 * Auditoria READ-ONLY da etapa Retenção no Novo CRM (PROD).
 *
 * Lista ao vivo os deals na etapa Retenção, cruza com caa_protocols (T0 =
 * first_seen_at) e com o snapshot de matriculados para classificar:
 *   a) CAA open T0 ≤ NOVO_CRM_CAA_RETENCAO_HOURS  → correto, permanece
 *   b) CAA open T0 > janela                        → deveria sair (Att pode mover)
 *   c) sem CAA open                                → guard "Retenção sem CAA open" trava a saída
 *   d) sem CPF/RGM no deal                         → flags sync nem considera (skipped_no_match)
 *
 * Também mede quantos têm stageId no espelho local diferente de Retenção
 * (cache stale → a Att acha que já está alinhado e não grava nada).
 *
 * Nenhuma escrita: só GET na API do CRM + SELECT no Postgres local.
 *
 * Uso: node scripts/_audit-retencao-live.mjs [--rate=8] [--out=data/arquivo.json]
 */

import 'dotenv/config';
import fs from 'node:fs';
import path from 'node:path';

const args = process.argv.slice(2);
const argVal = (name, def) => {
  const hit = args.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : def;
};

// GETs apenas: acelera a leitura sem risco de escrita.
process.env.NOVO_CRM_API_RATE_PER_SECOND = String(
  Math.min(Math.max(Number(argVal('rate', 8)) || 8, 1), 20)
);

const { query } = await import('../server/db/client.js');
const baseUploadRepo = await import('../server/repositories/baseUploadRepository.js');
const { getDeal } = await import('../server/services/novoCrmClient.js');
const {
  classifyMatriculado,
  getCaaRetencaoHours,
  getNovoCrmStageIds,
  stageNameFromId,
} = await import('../server/utils/novoCrmStageRules.js');
const { extractMatriculadosMappedValues } = await import(
  '../server/utils/novoCrmFieldMapping.js'
);
const { createRateLimiter } = await import('../server/utils/rateLimiter.js');

const digits = (v) => String(v ?? '').replace(/\D/g, '');

const API_BASE = String(process.env.NOVO_CRM_API_BASE_URL || '').replace(/\/$/, '');
const API_TOKEN = String(process.env.NOVO_CRM_API_TOKEN || '').trim();
if (!API_BASE || !API_TOKEN) {
  console.error('NOVO_CRM_API_BASE_URL / NOVO_CRM_API_TOKEN ausentes.');
  process.exit(1);
}
const listLimiter = createRateLimiter(Number(process.env.NOVO_CRM_API_RATE_PER_SECOND), 1000);

async function apiGet(pathname) {
  await listLimiter.acquire();
  const res = await fetch(`${API_BASE}${pathname}`, {
    headers: { Authorization: `Bearer ${API_TOKEN}`, Accept: 'application/json' },
  });
  const txt = await res.text();
  if (!res.ok) throw new Error(`GET ${pathname} → HTTP ${res.status} ${txt.slice(0, 200)}`);
  return txt ? JSON.parse(txt) : null;
}

const stages = getNovoCrmStageIds();
const retencaoStageId = String(stages.Retenção || '').trim();
if (!retencaoStageId) {
  console.error('Stage Retenção não resolvido (env / data/novo-crm-prod-ids.json).');
  process.exit(1);
}
const retencaoHours = getCaaRetencaoHours();
const now = new Date();

// ── 1. Deals ao vivo na etapa Retenção ────────────────────────────────────────
console.log(`[1/6] Listando deals na etapa Retenção (${new URL(API_BASE).host})…`);
/** @type {Array<object>} */
const liveDeals = [];
let page = 1;
let apiTotal = null;
while (true) {
  const res = await apiGet(`/api/deals?page=${page}&perPage=100&stageId=${retencaoStageId}`);
  const items = Array.isArray(res?.items) ? res.items : [];
  if (apiTotal == null) apiTotal = Number(res?.total) || items.length;
  liveDeals.push(...items);
  if (!items.length || liveDeals.length >= apiTotal || page > 60) break;
  page += 1;
}
const offStage = liveDeals.filter((d) => String(d.stageId) !== retencaoStageId).length;
console.log(`      total API=${apiTotal} · coletados=${liveDeals.length} · fora da etapa=${offStage}`);

// ── 2. CPF/RGM por deal (getDeal → dealPanelFields) ───────────────────────────
console.log(`[2/6] Lendo custom fields de ${liveDeals.length} deals…`);
const readField = (full, names) => {
  const wanted = names.map((n) => n.toLowerCase());
  for (const f of full?.dealPanelFields || []) {
    const nm = String(f?.name || '').trim().toLowerCase();
    if (wanted.includes(nm) && f?.value != null && String(f.value).trim() !== '') {
      return String(f.value).trim();
    }
  }
  return '';
};

/** @type {Map<string, {cpf:string,rgm:string,error?:string}>} */
const fieldsByDeal = new Map();
let cursor = 0;
const CONC = 6;
await Promise.all(
  Array.from({ length: CONC }, async () => {
    while (true) {
      const i = cursor++;
      if (i >= liveDeals.length) return;
      const id = String(liveDeals[i].id);
      try {
        const full = await getDeal(id);
        fieldsByDeal.set(id, {
          cpf: digits(readField(full, ['cpf'])),
          rgm: digits(readField(full, ['rgm'])),
        });
      } catch (err) {
        fieldsByDeal.set(id, { cpf: '', rgm: '', error: err?.message || String(err) });
      }
      if ((i + 1) % 50 === 0) console.log(`      ${i + 1}/${liveDeals.length}`);
    }
  })
);

// ── 3. caa_protocols → open/closed + T0 (first_seen_at) ───────────────────────
console.log('[3/6] Cruzando caa_protocols…');
const { rows: caaRows } = await query(
  `select protocolo, rgm, cpf, status, first_seen_at, last_status_change_at, data
     from caa_protocols`
);
/** @type {Map<string, {open:boolean,t0:Date|null,status:string,protocolo:string}>} */
const caaByKey = new Map();
for (const p of caaRows) {
  const data = p?.data && typeof p.data === 'object' ? p.data : {};
  const cpf = digits(p.cpf || data.CPF || data.cpf);
  const rgm = digits(p.rgm || data.RGM || data.rgm);
  const open = p.status === 'open';
  const t0raw = p.first_seen_at || null;
  const t0 = t0raw ? new Date(t0raw) : null;
  const entry = {
    open,
    t0: t0 && !Number.isNaN(t0.getTime()) ? t0 : null,
    status: p.status,
    protocolo: p.protocolo,
  };
  const put = (key) => {
    if (!key) return;
    const prev = caaByKey.get(key);
    if (!prev) return void caaByKey.set(key, entry);
    // open vence closed; entre dois open, T0 mais recente vence.
    if (entry.open && !prev.open) return void caaByKey.set(key, entry);
    if (entry.open === prev.open) {
      const a = entry.t0?.getTime() || 0;
      const b = prev.t0?.getTime() || 0;
      if (a > b) caaByKey.set(key, entry);
    }
  };
  if (cpf.length >= 11) put(`cpf:${cpf}`);
  if (rgm) put(`rgm:${rgm}`);
}
const lookupCaa = (cpf, rgm) =>
  (cpf && caaByKey.get(`cpf:${cpf}`)) || (rgm && caaByKey.get(`rgm:${rgm}`)) || null;

// ── 4. Matriculados + bases satélite (mesmo contexto do flags sync) ───────────
console.log('[4/6] Carregando matriculados + bases satélite…');
const matSnap = await baseUploadRepo.getLatestSnapshot('matriculados');
if (!matSnap?.id) {
  console.error('Snapshot de matriculados ausente.');
  process.exit(1);
}
const situacaoRank = (row) => {
  const sit = String(row['Situação Matrícula'] || row.Situacao || '')
    .toUpperCase()
    .normalize('NFD')
    .replace(/\p{M}/gu, '');
  if (sit.includes('CURSO')) return 0;
  if (sit.includes('CANCEL')) return 2;
  return 1;
};
const byCpf = new Map();
const byRgm = new Map();
const keepBest = (map, key, row) => {
  if (!key) return;
  const prev = map.get(key);
  if (!prev || situacaoRank(row) < situacaoRank(prev)) map.set(key, row);
};
await baseUploadRepo.forEachRowDataForSnapshot('matriculados', matSnap.id, (row) => {
  const m = extractMatriculadosMappedValues(row);
  const c = digits(m.cpf);
  const r = digits(m.rgm);
  if (c.length >= 11) keepBest(byCpf, c, row);
  if (r) keepBest(byRgm, r, row);
});

async function loadIdSet(category) {
  const set = new Set();
  const snap = await baseUploadRepo.getLatestSnapshot(category);
  if (!snap?.id) return set;
  await baseUploadRepo.forEachRowDataForSnapshot(category, snap.id, (row) => {
    const cpf = digits(row.CPF || row.cpf || row.Cpf);
    const rgm = digits(row.RGM || row.rgm || row.Rgm);
    if (cpf.length >= 11) set.add(`cpf:${cpf}`);
    if (rgm) set.add(`rgm:${rgm}`);
  });
  return set;
}
const [remat, doc, inad, bb, evasao] = await Promise.all([
  loadIdSet('rematricula'),
  loadIdSet('docs-pendentes'),
  loadIdSet('inadimplentes-vencidos'),
  loadIdSet('acessos-blackboard'),
  loadIdSet('provavel-evasao'),
]);
const inSet = (set, cpf, rgm) =>
  Boolean((cpf && set.has(`cpf:${cpf}`)) || (rgm && set.has(`rgm:${rgm}`)));

// ── 5. stageId no espelho local (evidência de cache stale) ────────────────────
console.log('[5/6] Lendo stageId do espelho local…');
const dealIds = liveDeals.map((d) => String(d.id));
const { rows: cacheDealRows } = await query(
  `select e.key as deal_id,
          e.value->>'stageId' as stage_id,
          c.contact_id,
          c.is_deleted
     from novo_crm_person_cache c,
          jsonb_each(coalesce(c.raw_data->'dealsById', '{}'::jsonb)) e
    where e.key = any($1::text[])`,
  [dealIds]
);
/** @type {Map<string, {stage_id:string|null,is_deleted:boolean}>} */
const cacheStageByDeal = new Map();
for (const r of cacheDealRows) {
  cacheStageByDeal.set(String(r.deal_id), {
    stage_id: r.stage_id ? String(r.stage_id) : null,
    is_deleted: Boolean(r.is_deleted),
  });
}
const { rows: cacheSyncRows } = await query(
  `select max(finished_at) as last_full
     from novo_crm_cache_sync_log
    where mode = 'full' and status = 'ok'`
).catch(() => ({ rows: [{ last_full: null }] }));

// ── 6. Classificação ──────────────────────────────────────────────────────────
console.log('[6/6] Classificando…');
const groups = { a: 0, b: 0, c: 0, d: 0 };
const targetByGroup = { b: {}, c: {} };
const semMatchMatriculados = { a: 0, b: 0, c: 0 };
let cacheStale = 0;
let cacheAligned = 0;
let cacheAbsent = 0;
let cacheUnknownStage = 0;
let cacheDeleted = 0;
const cacheStaleStages = {};
const updatedAtByDay = {};
let comOwner = 0;
/** @type {Array<object>} */
const items = [];

for (const d of liveDeals) {
  const dealId = String(d.id);
  const f = fieldsByDeal.get(dealId) || { cpf: '', rgm: '' };
  const cpfDeal = f.cpf;
  const rgmDeal = f.rgm;
  const matRow =
    (rgmDeal && byRgm.get(rgmDeal)) || (cpfDeal.length >= 11 && byCpf.get(cpfDeal)) || null;
  const mapped = matRow ? extractMatriculadosMappedValues(matRow) : null;
  const cpf = digits(mapped?.cpf) || cpfDeal;
  const rgm = digits(mapped?.rgm) || rgmDeal;

  const caa = lookupCaa(cpf, rgm);
  const caaOpen = Boolean(caa?.open);
  const t0 = caaOpen ? caa.t0 : null;
  const ageH = t0 ? (now.getTime() - t0.getTime()) / 3_600_000 : null;
  const fresh = ageH != null && ageH <= retencaoHours;

  let group;
  if (!cpfDeal && !rgmDeal) group = 'd';
  else if (caaOpen && fresh) group = 'a';
  else if (caaOpen) group = 'b';
  else group = 'c';
  groups[group] += 1;
  if (group !== 'd' && !matRow) semMatchMatriculados[group] += 1;

  let target = null;
  if (matRow && (group === 'b' || group === 'c')) {
    const cls = classifyMatriculado(matRow, {
      inRematricula: inSet(remat, cpf, rgm),
      inCaaFresh: false,
      inDoc: inSet(doc, cpf, rgm),
      inInad: inSet(inad, cpf, rgm),
      inBb: inSet(bb, cpf, rgm),
      inEvasao: inSet(evasao, cpf, rgm),
      now,
    });
    target = cls.stageName;
    targetByGroup[group][target] = (targetByGroup[group][target] || 0) + 1;
  } else if (group === 'b' || group === 'c') {
    targetByGroup[group]['(sem match matriculados)'] =
      (targetByGroup[group]['(sem match matriculados)'] || 0) + 1;
  }

  const cached = cacheStageByDeal.get(dealId);
  let cacheState;
  if (!cached) {
    cacheState = 'ausente_no_espelho';
    cacheAbsent += 1;
  } else if (cached.is_deleted) {
    cacheState = 'contact_is_deleted';
    cacheDeleted += 1;
  } else if (!cached.stage_id) {
    cacheState = 'stage_desconhecido';
    cacheUnknownStage += 1;
  } else if (cached.stage_id === retencaoStageId) {
    cacheState = 'alinhado';
    cacheAligned += 1;
  } else {
    cacheState = 'stale';
    cacheStale += 1;
    const nm = stageNameFromId(cached.stage_id) || cached.stage_id;
    cacheStaleStages[nm] = (cacheStaleStages[nm] || 0) + 1;
  }

  const day = String(d.updatedAt || '').slice(0, 10);
  updatedAtByDay[day || '(sem updatedAt)'] = (updatedAtByDay[day || '(sem updatedAt)'] || 0) + 1;
  if (d.ownerId) comOwner += 1;

  items.push({
    deal_id: dealId,
    number: d.number ?? null,
    title: d.title ?? null,
    contact_id: d.contactId ?? null,
    owner_id: d.ownerId ?? null,
    created_at: d.createdAt ?? null,
    updated_at: d.updatedAt ?? null,
    cpf,
    rgm,
    cpf_no_deal: Boolean(cpfDeal),
    rgm_no_deal: Boolean(rgmDeal),
    grupo: group,
    caa_status: caa?.status || null,
    caa_protocolo: caa?.protocolo || null,
    caa_open: caaOpen,
    caa_t0: t0 ? t0.toISOString() : null,
    caa_idade_horas: ageH != null ? Math.round(ageH * 10) / 10 : null,
    match_matriculados: Boolean(matRow),
    alvo_classify: target,
    cache_stage_id: cached?.stage_id || null,
    cache_stage_nome: cached?.stage_id ? stageNameFromId(cached.stage_id) || cached.stage_id : null,
    cache_state: cacheState,
    getdeal_error: f.error || null,
  });
}

const result = {
  generated_at: now.toISOString(),
  crm_host: new URL(API_BASE).host,
  retencao_stage_id: retencaoStageId,
  caa_retencao_hours: retencaoHours,
  matriculados_snapshot_id: matSnap.id,
  ultimo_full_sync_cache: cacheSyncRows?.[0]?.last_full || null,
  total_api: apiTotal,
  total_coletado: liveDeals.length,
  grupos: {
    a_caa_open_fresh_permanece: groups.a,
    b_caa_open_expirado_deveria_sair: groups.b,
    c_sem_caa_open_travado_pelo_guard: groups.c,
    d_sem_cpf_rgm_no_deal: groups.d,
  },
  sem_match_matriculados: semMatchMatriculados,
  alvo_agregado: targetByGroup,
  espelho_local: {
    stale_diferente_de_retencao: cacheStale,
    alinhado_retencao: cacheAligned,
    ausente_no_espelho: cacheAbsent,
    stage_desconhecido: cacheUnknownStage,
    contact_is_deleted: cacheDeleted,
    stale_por_etapa_no_cache: cacheStaleStages,
  },
  updated_at_por_dia: updatedAtByDay,
  deals_com_owner: comOwner,
  getdeal_errors: items.filter((i) => i.getdeal_error).length,
  items,
};

const outPath = path.resolve(
  process.cwd(),
  argVal('out', `data/retencao-live-audit-${Date.now()}.json`)
);
fs.mkdirSync(path.dirname(outPath), { recursive: true });
fs.writeFileSync(outPath, JSON.stringify(result, null, 2));

console.log('\n=== RESUMO ===');
console.log(JSON.stringify({ ...result, items: undefined }, null, 2));
console.log(`\nJSON: ${outPath}`);
process.exit(0);
