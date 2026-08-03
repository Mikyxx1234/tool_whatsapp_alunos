/**
 * Simulação READ-ONLY: filas Novo CRM (current vs target) com a mesma lógica
 * do Att de etapas (flags_stage sync).
 *
 * Unidade: deal no espelho `novo_crm_person_cache` (todos os deals do contact,
 * igual `runFlagsStageSync`) que casam com matriculados por CPF/RGM.
 *
 * Uso: node scripts/novo-crm-stage-sim.mjs
 * Saída: data/stage-sim-<ts>.json + tabela no stdout
 *
 * NÃO escreve no CRM.
 */
import 'dotenv/config';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as baseUploadRepo from '../server/repositories/baseUploadRepository.js';
import * as caaProtocolsRepo from '../server/repositories/caaProtocolsRepository.js';
import * as cacheRepo from '../server/repositories/novoCrmPersonCacheRepository.js';
import { extractMatriculadosMappedValues } from '../server/utils/novoCrmFieldMapping.js';
import {
  classifyMatriculado,
  getCaaRetencaoHours,
  getNovoCrmStageIds,
  isCaaWithinRetencaoWindow,
  isUntouchableStageId,
  stageNameFromId,
} from '../server/utils/novoCrmStageRules.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

function digits(v) {
  return String(v ?? '').replace(/\D/g, '');
}

function situacaoRank(row) {
  const sit = String(row['Situação Matrícula'] || row.Situacao || '')
    .toUpperCase()
    .normalize('NFD')
    .replace(/\p{M}/gu, '');
  if (sit.includes('CURSO')) return 0;
  if (sit.includes('CANCEL')) return 2;
  return 1;
}

function keepBestRow(map, key, row) {
  if (!key) return;
  const prev = map.get(key);
  if (!prev || situacaoRank(row) < situacaoRank(prev)) map.set(key, row);
}

async function loadIdSetFromBase(category) {
  const set = new Set();
  const snap = await baseUploadRepo.getLatestSnapshot(category);
  if (!snap?.id) return { set, snap: null };
  await baseUploadRepo.forEachRowDataForSnapshot(category, snap.id, (row) => {
    const cpf = digits(row.CPF || row.cpf || row.Cpf);
    const rgm = digits(row.RGM || row.rgm || row.Rgm);
    if (cpf.length >= 11) set.add(`cpf:${cpf}`);
    if (rgm) set.add(`rgm:${rgm}`);
  });
  return { set, snap };
}

function inSet(set, cpf, rgm) {
  if (cpf && set.has(`cpf:${cpf}`)) return true;
  if (rgm && set.has(`rgm:${rgm}`)) return true;
  return false;
}

function findCustom(deal, names) {
  const wanted = names.map((n) => n.toLowerCase());
  for (const f of deal?.customFields || []) {
    const name = String(f?.name || '')
      .trim()
      .toLowerCase();
    if (wanted.includes(name) && f?.value != null && String(f.value).trim() !== '') {
      return String(f.value).trim();
    }
  }
  return '';
}

function dealsFromCacheRow(row) {
  const raw = row?.raw_data || {};
  const byId = raw.dealsById && typeof raw.dealsById === 'object' ? raw.dealsById : {};
  const list = Object.values(byId);
  if (list.length) return list;
  if (row.primary_deal_id) {
    return [{ id: String(row.primary_deal_id), stageId: null, customFields: [] }];
  }
  return [];
}

function bump(map, key, n = 1) {
  const k = key || '(sem stage)';
  map[k] = (map[k] || 0) + n;
}

function resolveCurrentStageName(deal, stageIds) {
  const stageId = String(deal?.stageId || deal?.stage?.id || '').trim();
  if (stageId) {
    const named = stageNameFromId(stageId);
    if (named) return named;
    // Lead de Entrada e outras etapas fora do mapa classify
    for (const [envKey, id] of Object.entries(stageIds._extra || {})) {
      if (id && id === stageId) return envKey;
    }
    return `id:${stageId.slice(0, 10)}…`;
  }
  const rawName = String(deal?.stageName || deal?.stage?.name || deal?.stage || '').trim();
  if (rawName) {
    // Normaliza aliases do CRM PROD
    if (/p[oó]s/i.test(rawName) && /grad/i.test(rawName)) return 'Pós';
    if (/sem\s*remat/i.test(rawName)) return 'Sem Rematricula';
    if (/reten/i.test(rawName)) return 'Retenção';
    if (/acolh/i.test(rawName)) return 'Acolhimento';
    if (/gradua/i.test(rawName)) return 'Graduação';
    if (/ganho/i.test(rawName)) return 'Ganho';
    if (/perdido/i.test(rawName)) return 'Perdido';
    if (/cancel/i.test(rawName)) return 'Cancelado';
    if (/lead/i.test(rawName)) return 'Lead de Entrada';
    return rawName;
  }
  return '(sem stage)';
}

function loadExtraStageIds() {
  // Etapas fora do mapa classify (pipeline PROD) — nomes amigáveis no relatório.
  return {
    'Lead de Entrada': 'cmrwd95sx01mfpd01axkzjhm8',
    'Em Atendimento': 'cmrxn1r190v2vo101kaqh4cup',
  };
}

const STAGE_ORDER = [
  'Lead de Entrada',
  'Acolhimento',
  'Graduação',
  'Pós',
  'Sem Rematricula',
  'Retenção',
  'Cancelado',
  'Ganho',
  'Perdido',
  '(sem stage)',
];

const now = new Date();
const matSnap = await baseUploadRepo.getLatestSnapshot('matriculados');
if (!matSnap?.id) {
  console.error('Snapshot matriculados ausente');
  process.exit(1);
}

console.log('Carregando bases satélite…');
const [
  { set: remat, snap: rematSnap },
  { set: doc, snap: docSnap },
  { set: inad, snap: inadSnap },
  { set: bb, snap: bbSnap },
  { set: evasao, snap: evasaoSnap },
  caaT0Map,
] = await Promise.all([
  loadIdSetFromBase('rematricula'),
  loadIdSetFromBase('docs-pendentes'),
  loadIdSetFromBase('inadimplentes-vencidos'),
  loadIdSetFromBase('acessos-blackboard'),
  loadIdSetFromBase('provavel-evasao'),
  caaProtocolsRepo.loadOpenCaaT0Map(),
]);

const caaRetencaoHours = getCaaRetencaoHours();
const stageIds = getNovoCrmStageIds();
stageIds._extra = loadExtraStageIds();
const retencaoStageId = String(stageIds.Retenção || '').trim();

console.log('Indexando matriculados…');
/** @type {Map<string, Record<string, unknown>>} */
const byCpf = new Map();
/** @type {Map<string, Record<string, unknown>>} */
const byRgm = new Map();
let rawRows = 0;
await baseUploadRepo.forEachRowDataForSnapshot('matriculados', matSnap.id, (row) => {
  rawRows += 1;
  const m = extractMatriculadosMappedValues(row);
  const cpf = digits(m.cpf);
  const rgm = digits(m.rgm);
  if (cpf.length >= 11) keepBestRow(byCpf, cpf, row);
  if (rgm) keepBestRow(byRgm, rgm, row);
});

console.log('Carregando espelho Sync (cache)…');
const cacheRows = await cacheRepo.listActiveCacheRowsForEnrichment({
  scope: 'all_mapped',
  limit: 100000,
});

/** @type {Record<string, number>} */
const currentAll = {};
/** @type {Record<string, number>} */
const currentMatched = {};
/** @type {Record<string, number>} */
const targetMatched = {};
/** @type {Record<string, number>} */
const effectiveAfterAtt = {};
/** @type {Record<string, number>} */
const moveFromTo = {};

let dealsTotal = 0;
let contactsNoDeal = 0;
let matched = 0;
let noMatch = 0;
let wouldMove = 0;
let stayUntouchable = 0;
let stayUnknown = 0;
let stayAligned = 0;
let caaOpenMatched = 0;
let caaFreshMatched = 0;
const breakout = {
  perdido_trancado: 0,
  perdido_cancelado: 0,
  retencao_caa_72h: 0,
  sem_rematricula: 0,
  acolhimento: 0,
  graduacao: 0,
  pos: 0,
  graduacao_default: 0,
};

for (const row of cacheRows) {
  const deals = dealsFromCacheRow(row);
  if (!deals.length) {
    contactsNoDeal += 1;
    continue;
  }
  const cpfCache = digits(row.cpf_norm);

  for (const deal of deals) {
    dealsTotal += 1;
    const currentName = resolveCurrentStageName(deal, stageIds);
    bump(currentAll, currentName);

    const rgmDeal = digits(findCustom(deal, ['rgm']) || row.rgm_norm);
    const cpfDeal = digits(findCustom(deal, ['cpf']) || cpfCache);
    const matRow =
      (rgmDeal && byRgm.get(rgmDeal)) || (cpfDeal.length >= 11 && byCpf.get(cpfDeal)) || null;
    if (!matRow) {
      noMatch += 1;
      bump(effectiveAfterAtt, currentName); // Att não mexe sem match
      continue;
    }
    matched += 1;
    bump(currentMatched, currentName);

    const mapped = extractMatriculadosMappedValues(matRow);
    const cpf = digits(mapped.cpf) || cpfDeal;
    const rgm = digits(mapped.rgm) || rgmDeal;
    const caaT0 = caaProtocolsRepo.lookupCaaT0(caaT0Map, cpf, rgm);
    const inCaaOpen = Boolean(caaT0);
    const inCaaFresh = isCaaWithinRetencaoWindow(caaT0, now);
    if (inCaaOpen) caaOpenMatched += 1;
    if (inCaaFresh) caaFreshMatched += 1;

    const cl = classifyMatriculado(matRow, {
      inRematricula: inSet(remat, cpf, rgm),
      inCaaFresh,
      inDoc: inSet(doc, cpf, rgm),
      inInad: inSet(inad, cpf, rgm),
      inBb: inSet(bb, cpf, rgm),
      inEvasao: inSet(evasao, cpf, rgm),
      now,
    });
    bump(targetMatched, cl.stageName);

    const m = cl.meta || {};
    if (cl.stageName === 'Perdido') {
      if (m.isTrancado) breakout.perdido_trancado += 1;
      else if (m.isCancelado) breakout.perdido_cancelado += 1;
    } else if (cl.stageName === 'Retenção') breakout.retencao_caa_72h += 1;
    else if (cl.stageName === 'Sem Rematricula') breakout.sem_rematricula += 1;
    else if (cl.stageName === 'Acolhimento') breakout.acolhimento += 1;
    else if (cl.stageName === 'Graduação') {
      breakout.graduacao += 1;
      if (!m.isGrad && !m.isPos) breakout.graduacao_default += 1;
    } else if (cl.stageName === 'Pós') breakout.pos += 1;

    // Espelha decideMove do flags sync
    const currentStageId = String(deal.stageId || '').trim() || null;
    let effectiveName = currentName;
    if (!currentStageId) {
      stayUnknown += 1;
      // fail-closed: não move
    } else if (isUntouchableStageId(currentStageId)) {
      stayUntouchable += 1;
    } else if (retencaoStageId && currentStageId === retencaoStageId && !inCaaOpen) {
      stayUntouchable += 1; // Retenção manual
    } else if (cl.stageId && cl.stageId === currentStageId) {
      stayAligned += 1;
      effectiveName = cl.stageName;
    } else if (cl.stageId) {
      wouldMove += 1;
      effectiveName = cl.stageName;
      const key = `${currentName} → ${cl.stageName}`;
      bump(moveFromTo, key);
    }
    bump(effectiveAfterAtt, effectiveName);
  }
}

/** Union of stage names for comparison table */
const allStageNames = new Set([
  ...STAGE_ORDER,
  ...Object.keys(currentAll),
  ...Object.keys(currentMatched),
  ...Object.keys(targetMatched),
  ...Object.keys(effectiveAfterAtt),
]);

function sortedStages(keys) {
  return [...keys].sort((a, b) => {
    const ia = STAGE_ORDER.indexOf(a);
    const ib = STAGE_ORDER.indexOf(b);
    if (ia >= 0 && ib >= 0) return ia - ib;
    if (ia >= 0) return -1;
    if (ib >= 0) return 1;
    return a.localeCompare(b);
  });
}

const comparison = sortedStages(allStageNames)
  .filter(
    (s) =>
      (currentMatched[s] || 0) +
        (targetMatched[s] || 0) +
        (effectiveAfterAtt[s] || 0) +
        (currentAll[s] || 0) >
      0
  )
  .map((stage) => {
    const current = currentMatched[stage] || 0;
    const target = targetMatched[stage] || 0;
    const effective = effectiveAfterAtt[stage] || 0;
    const current_all_deals = currentAll[stage] || 0;
    return {
      stage,
      current_matched: current,
      target_rules: target,
      delta_target_vs_current: target - current,
      effective_after_att: effective,
      delta_effective_vs_current: effective - current,
      current_all_deals,
    };
  });

const result = {
  simulated_at: now.toISOString(),
  simulated_at_brt: now.toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' }),
  unit: 'deal (todos os deals do contact no espelho, igual Att de etapas)',
  rule:
    'classifyMatriculado: CANCEL/TRANC→Perdido; CAA open≤72h→Retenção; remat→Sem Rematricula; acolhimento; Pós/Graduação. Att: não move Ganho/Cancelado; Retenção sem CAA open=manual (fica).',
  caa_retencao_hours: caaRetencaoHours,
  snapshots: {
    matriculados: {
      id: matSnap.id,
      file_name: matSnap.file_name || matSnap.original_filename || null,
      created_at: matSnap.created_at || null,
      row_count: matSnap.row_count ?? rawRows,
      distinct_cpf: byCpf.size,
      distinct_rgm: byRgm.size,
    },
    rematricula: rematSnap
      ? { id: rematSnap.id, created_at: rematSnap.created_at, id_keys: remat.size }
      : null,
    docs_pendentes: docSnap ? { id: docSnap.id, id_keys: doc.size } : null,
    inadimplentes_vencidos: inadSnap ? { id: inadSnap.id, id_keys: inad.size } : null,
    acessos_blackboard: bbSnap ? { id: bbSnap.id, id_keys: bb.size } : null,
    provavel_evasao: evasaoSnap ? { id: evasaoSnap.id, id_keys: evasao.size } : null,
    caa_open: {
      id_keys: caaT0Map.size,
      retencao_hours: caaRetencaoHours,
    },
  },
  coverage: {
    cache_contacts: cacheRows.length,
    contacts_no_deal: contactsNoDeal,
    deals_total: dealsTotal,
    matched_matriculados: matched,
    no_match: noMatch,
    caa_open_among_matched: caaOpenMatched,
    caa_fresh_72h_among_matched: caaFreshMatched,
  },
  att_preview: {
    would_move: wouldMove,
    stay_aligned: stayAligned,
    stay_untouchable: stayUntouchable,
    stay_unknown_stage: stayUnknown,
    top_moves: Object.entries(moveFromTo)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 25)
      .map(([from_to, n]) => ({ from_to, n })),
  },
  breakout_target: breakout,
  current_all_deals: currentAll,
  current_matched: currentMatched,
  target_rules: targetMatched,
  effective_after_att: effectiveAfterAtt,
  comparison,
};

const ts = Date.now();
const outPath = path.join(ROOT, 'data', `stage-sim-${ts}.json`);
fs.mkdirSync(path.dirname(outPath), { recursive: true });
fs.writeFileSync(outPath, JSON.stringify(result, null, 2), 'utf8');

console.log('\n=== Simulação filas Novo CRM (READ-ONLY) ===');
console.log(`Quando: ${result.simulated_at_brt} BRT`);
console.log(`Unidade: ${result.unit}`);
console.log(
  `Cache contacts=${cacheRows.length} · deals=${dealsTotal} · matched=${matched} · no_match=${noMatch}`
);
console.log(
  `CAA open keys=${caaT0Map.size} · matched com CAA open=${caaOpenMatched} · fresh≤${caaRetencaoHours}h=${caaFreshMatched}`
);
console.log(
  `Att preview: move=${wouldMove} · alinhado=${stayAligned} · intocável=${stayUntouchable} · stage desconhecido=${stayUnknown}`
);

console.log('\nEtapa'.padEnd(20) + 'Atual'.padStart(8) + 'Alvo'.padStart(8) + 'Δ'.padStart(8) + 'Efetivo*'.padStart(10));
console.log('-'.repeat(54));
for (const r of comparison) {
  if (!r.current_matched && !r.target_rules && !r.effective_after_att) continue;
  const d = r.delta_target_vs_current;
  const dStr = (d > 0 ? `+${d}` : String(d)).padStart(8);
  console.log(
    r.stage.padEnd(20) +
      String(r.current_matched).padStart(8) +
      String(r.target_rules).padStart(8) +
      dStr +
      String(r.effective_after_att).padStart(10)
  );
}
console.log('\n*Efetivo = após Att respeitando Ganho/Cancelado + Retenção manual (sem CAA open).');
console.log('\nTop moves (se rodasse Att):');
for (const m of result.att_preview.top_moves.slice(0, 12)) {
  console.log(`  ${m.from_to.padEnd(40)} ${m.n}`);
}
console.log(`\nJSON: ${outPath}`);
