/**
 * Simulação: quantas pessoas (deals no espelho Sync) deveriam estar em cada
 * fila do Novo CRM — mesma regra do Att de etapas (classifyMatriculado + CAA 72h
 * + untouchable Ganho/Cancelado + Retenção manual).
 *
 * Sem escrita no CRM. Usa só Postgres local + snapshots.
 *
 * Uso: node --env-file=.env scripts/novo-crm-filas-sync-sim.mjs
 * Saída: data/filas-sync-sim-<ts>.json + tabela no stdout
 */
import 'dotenv/config';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { applyNovoCrmProdIdsFromFile } from './_applyNovoCrmProdIds.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

// IDs PROD antes de importar stage rules (stageNameFromId / untouchable).
const prodIds = applyNovoCrmProdIdsFromFile();
if (!process.env.NOVO_CRM_API_BASE_URL) {
  process.env.NOVO_CRM_API_BASE_URL = 'https://crm.eduit.com.br';
}

const baseUploadRepo = await import('../server/repositories/baseUploadRepository.js');
const caaProtocolsRepo = await import('../server/repositories/caaProtocolsRepository.js');
const cacheRepo = await import('../server/repositories/novoCrmPersonCacheRepository.js');
const { extractMatriculadosMappedValues } = await import('../server/utils/novoCrmFieldMapping.js');
const {
  classifyMatriculado,
  getCaaRetencaoHours,
  getNovoCrmStageIds,
  isCaaWithinRetencaoWindow,
  isUntouchableStageId,
  stageNameFromId,
} = await import('../server/utils/novoCrmStageRules.js');

function digits(v) {
  return String(v ?? '').replace(/\D/g, '');
}

function inSet(set, cpf, rgm) {
  if (cpf && set.has(`cpf:${cpf}`)) return true;
  if (rgm && set.has(`rgm:${rgm}`)) return true;
  return false;
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

function bump(map, key) {
  const k = key || '(desconhecido)';
  map[k] = (map[k] || 0) + 1;
}

function currentStageLabel(deal) {
  const stageId = String(deal?.stageId || '').trim() || null;
  const fromId = stageNameFromId(stageId);
  if (fromId) return fromId;
  const name = String(deal?.stageName || deal?.stage || '').trim();
  if (name) return name;
  if (stageId) return `(id:${stageId.slice(0, 8)}…)`;
  return '(sem stage)';
}

const now = new Date();
const caaRetencaoHours = getCaaRetencaoHours();
const stageIds = getNovoCrmStageIds();
const retencaoStageId = String(stageIds.Retenção || '').trim();

console.log('[filas-sync-sim] carregando snapshots…');
const matSnap = await baseUploadRepo.getLatestSnapshot('matriculados');
if (!matSnap?.id) {
  console.error('Snapshot matriculados ausente');
  process.exit(1);
}

const [
  rematPack,
  caaT0Map,
  docPack,
  inadPack,
  bbPack,
  evasaoPack,
] = await Promise.all([
  loadIdSetFromBase('rematricula'),
  caaProtocolsRepo.loadOpenCaaT0Map(),
  loadIdSetFromBase('docs-pendentes'),
  loadIdSetFromBase('inadimplentes-vencidos'),
  loadIdSetFromBase('acessos-blackboard'),
  loadIdSetFromBase('provavel-evasao'),
]);

const remat = rematPack.set;
const doc = docPack.set;
const inad = inadPack.set;
const bb = bbPack.set;
const evasao = evasaoPack.set;

/** @type {Map<string, Record<string, unknown>>} */
const byCpf = new Map();
/** @type {Map<string, Record<string, unknown>>} */
const byRgm = new Map();
let matRows = 0;
await baseUploadRepo.forEachRowDataForSnapshot('matriculados', matSnap.id, (row) => {
  matRows += 1;
  const m = extractMatriculadosMappedValues(row);
  const cpf = digits(m.cpf);
  const rgm = digits(m.rgm);
  if (cpf.length >= 11) keepBestRow(byCpf, cpf, row);
  if (rgm) keepBestRow(byRgm, rgm, row);
});

console.log('[filas-sync-sim] carregando cache Sync…');
const cacheRows = await cacheRepo.listActiveCacheRowsForEnrichment({
  scope: 'all_mapped',
  limit: 100000,
});

let cacheStatus = null;
try {
  cacheStatus = await cacheRepo.getCacheStats();
} catch (err) {
  console.warn(`[filas-sync-sim] getCacheStats skip: ${err?.message || err}`);
}

const byTarget = {};
const byCurrent = {};
const byEffective = {}; // após untouchable: o que ficaria na fila
const wouldMove = {};
const keepUntouchable = {};
const delta = {}; // target - current (só matched)
let contactsActive = cacheRows.length;
let contactsWithDeal = 0;
let contactsNoDeal = 0;
let dealsScanned = 0;
let matched = 0;
let unmatched = 0;
let wouldMoveTotal = 0;
let keepUntouchableTotal = 0;
let keepAligned = 0;
let keepUnknownStage = 0;
let keepRetencaoManual = 0;
let caaOpenMatched = 0;
let caaFreshMatched = 0;

for (const row of cacheRows) {
  const deals = dealsFromCacheRow(row);
  if (!deals.length) {
    contactsNoDeal += 1;
    continue;
  }
  contactsWithDeal += 1;
  const cpfCache = digits(row.cpf_norm);

  for (const deal of deals) {
    dealsScanned += 1;
    const rgmDeal = digits(findCustom(deal, ['rgm']) || row.rgm_norm);
    const cpfDeal = digits(findCustom(deal, ['cpf']) || cpfCache);
    const matRow =
      (rgmDeal && byRgm.get(rgmDeal)) || (cpfDeal.length >= 11 && byCpf.get(cpfDeal)) || null;
    if (!matRow) {
      unmatched += 1;
      continue;
    }
    matched += 1;

    const mapped = extractMatriculadosMappedValues(matRow);
    const cpf = digits(mapped.cpf) || cpfDeal;
    const rgm = digits(mapped.rgm) || rgmDeal;
    const caaT0 = caaProtocolsRepo.lookupCaaT0(caaT0Map, cpf, rgm);
    const inCaaOpen = Boolean(caaT0);
    const inCaaFresh = isCaaWithinRetencaoWindow(caaT0, now);
    if (inCaaOpen) caaOpenMatched += 1;
    if (inCaaFresh) caaFreshMatched += 1;

    const classification = classifyMatriculado(matRow, {
      inRematricula: inSet(remat, cpf, rgm),
      inCaaFresh,
      inDoc: inSet(doc, cpf, rgm),
      inInad: inSet(inad, cpf, rgm),
      inBb: inSet(bb, cpf, rgm),
      inEvasao: inSet(evasao, cpf, rgm),
    });

    const target = classification.stageName || '(sem target)';
    const currentStageId = String(deal.stageId || '').trim() || null;
    const current = currentStageLabel(deal);

    bump(byTarget, target);
    bump(byCurrent, current);

    let effective = target;
    let action = 'aligned';

    if (!currentStageId) {
      keepUnknownStage += 1;
      action = 'unknown_stage';
      effective = current; // fail-closed: não move
    } else if (isUntouchableStageId(currentStageId)) {
      keepUntouchableTotal += 1;
      bump(keepUntouchable, current);
      action = 'untouchable';
      effective = current;
    } else if (retencaoStageId && currentStageId === retencaoStageId && !inCaaOpen) {
      keepRetencaoManual += 1;
      action = 'retencao_manual';
      effective = current;
    } else if (classification.stageId && classification.stageId !== currentStageId) {
      wouldMoveTotal += 1;
      const key = `${current} → ${target}`;
      bump(wouldMove, key);
      action = 'would_move';
      effective = target;
    } else {
      keepAligned += 1;
      action = 'aligned';
      effective = current;
    }

    bump(byEffective, effective);
    void action;
  }
}

for (const stage of new Set([...Object.keys(byTarget), ...Object.keys(byCurrent)])) {
  delta[stage] = (byTarget[stage] || 0) - (byCurrent[stage] || 0);
}

const result = {
  simulated_at: now.toISOString(),
  simulated_at_brt: now.toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' }),
  method:
    'cache Sync (novo_crm_person_cache) × matriculados + classifyMatriculado — espelho do dry-run flags_stage (sem API)',
  rule:
    'CAA open ≤72h→Retenção; CANCEL/TRANC→Perdido; remat→Sem Rematricula; Acolhimento; Pós/Graduação; untouchable Ganho+Cancelado; Retenção sem CAA open=manual',
  caa_retencao_hours: caaRetencaoHours,
  prod_pipeline: prodIds.pipeline?.name || null,
  snapshots: {
    matriculados: {
      id: matSnap.id,
      file_name: matSnap.file_name || matSnap.original_filename || null,
      created_at: matSnap.created_at || null,
      row_count: matSnap.row_count ?? matRows,
      indexed_cpf: byCpf.size,
      indexed_rgm: byRgm.size,
    },
    rematricula: rematPack.snap
      ? {
          id: rematPack.snap.id,
          file_name: rematPack.snap.file_name || rematPack.snap.original_filename || null,
          created_at: rematPack.snap.created_at || null,
          id_keys: remat.size,
        }
      : null,
    docs_pendentes_keys: doc.size,
    inad_keys: inad.size,
    bb_keys: bb.size,
    evasao_keys: evasao.size,
    caa_open_t0: caaT0Map.size,
  },
  cache: {
    contacts_active: contactsActive,
    contacts_with_deal: contactsWithDeal,
    contacts_no_deal: contactsNoDeal,
    last_sync: cacheStatus?.last_sync || null,
    active_count: cacheStatus?.active ?? null,
  },
  totals: {
    deals_scanned: dealsScanned,
    matched_matriculados: matched,
    unmatched: unmatched,
    would_move: wouldMoveTotal,
    keep_aligned: keepAligned,
    keep_untouchable: keepUntouchableTotal,
    keep_retencao_manual: keepRetencaoManual,
    keep_unknown_stage: keepUnknownStage,
    caa_open_matched: caaOpenMatched,
    caa_fresh_matched: caaFreshMatched,
  },
  by_target_stage: byTarget,
  by_current_stage: byCurrent,
  by_effective_stage: byEffective,
  delta_target_minus_current: delta,
  would_move_top: Object.entries(wouldMove)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 25)
    .map(([from_to, n]) => ({ from_to, n })),
  keep_untouchable_by_stage: keepUntouchable,
};

const ts = Date.now();
const outPath = path.join(ROOT, 'data', `filas-sync-sim-${ts}.json`);
fs.mkdirSync(path.dirname(outPath), { recursive: true });
fs.writeFileSync(outPath, JSON.stringify(result, null, 2), 'utf8');

function printMap(label, map) {
  console.log(`\n=== ${label} ===`);
  const entries = Object.entries(map).sort((a, b) => b[1] - a[1]);
  const total = entries.reduce((a, [, n]) => a + n, 0);
  for (const [name, n] of entries) {
    const pct = total ? ((n / total) * 100).toFixed(1) : '0.0';
    console.log(`  ${name.padEnd(22)} ${String(n).padStart(7)}  (${pct}%)`);
  }
  console.log(`  ${'TOTAL'.padEnd(22)} ${String(total).padStart(7)}`);
}

console.log('\nSimulação filas Sync Novo CRM (dry, sem writes)');
console.log(`Simulado: ${result.simulated_at_brt} BRT`);
console.log(
  `Matriculados: ${matSnap.file_name || matSnap.id} @ ${matSnap.created_at || '?'}`
);
console.log(
  `Cache contacts: ${contactsActive} | com deal: ${contactsWithDeal} | sem deal: ${contactsNoDeal}`
);
console.log(
  `Deals: scanned=${dealsScanned} matched=${matched} unmatched=${unmatched}`
);
console.log(
  `CAA: open_matched=${caaOpenMatched} fresh≤${caaRetencaoHours}h=${caaFreshMatched}`
);
console.log(
  `Move: would_move=${wouldMoveTotal} aligned=${keepAligned} untouchable=${keepUntouchableTotal} retencao_manual=${keepRetencaoManual} unknown_stage=${keepUnknownStage}`
);
printMap('Etapa ALVO (classifyMatriculado)', byTarget);
printMap('Etapa ATUAL (cache Sync)', byCurrent);
printMap('Etapa EFETIVA (após untouchable)', byEffective);
console.log('\n=== Delta (alvo − atual) nos matched ===');
for (const [name, n] of Object.entries(delta).sort((a, b) => Math.abs(b[1]) - Math.abs(a[1]))) {
  if (!n) continue;
  console.log(`  ${name.padEnd(22)} ${String(n).padStart(7)}`);
}
console.log('\n=== Top would_move ===');
for (const { from_to, n } of result.would_move_top.slice(0, 15)) {
  console.log(`  ${from_to.padEnd(40)} ${String(n).padStart(6)}`);
}
console.log(`\nJSON: ${outPath}`);
