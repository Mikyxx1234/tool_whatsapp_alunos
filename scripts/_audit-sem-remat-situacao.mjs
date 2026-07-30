/**
 * READ-ONLY audit: deals with target stage = Sem Rematricula where
 * Situação carousel in cache != 'Sem Rematrícula'.
 * Counts how many would have Situação corrected by the new flags_stage logic.
 *
 * Uso: node scripts/_audit-sem-remat-situacao.mjs
 * NÃO escreve nada.
 */
import 'dotenv/config';
import * as baseUploadRepo from '../server/repositories/baseUploadRepository.js';
import * as caaProtocolsRepo from '../server/repositories/caaProtocolsRepository.js';
import * as cacheRepo from '../server/repositories/novoCrmPersonCacheRepository.js';
import {
  extractMatriculadosMappedValues,
  normalizeSituacaoCrm,
  SITUACAO_CRM_SEM_REMATRICULA,
} from '../server/utils/novoCrmFieldMapping.js';
import {
  classifyMatriculado,
  getCaaRetencaoHours,
  getNovoCrmDealFieldIds,
  isCaaWithinRetencaoWindow,
} from '../server/utils/novoCrmStageRules.js';

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

function findCustom(deal, names) {
  const wanted = names.map((n) => n.toLowerCase());
  for (const f of deal?.customFields || []) {
    const name = String(f?.name || '').trim().toLowerCase();
    if (wanted.includes(name) && f?.value != null && String(f.value).trim() !== '') {
      return String(f.value).trim();
    }
  }
  return '';
}

function readDealFieldById(deal, fieldId) {
  const id = String(fieldId || '').trim();
  if (!id) return '';
  for (const f of deal?.customFields || []) {
    const fid = String(f?.id || f?.fieldId || '').trim();
    if (fid === id && f?.value != null && String(f.value).trim() !== '') {
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

async function loadIdSetFromBase(category) {
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

// ---- Main ----
const matSnap = await baseUploadRepo.getLatestSnapshot('matriculados');
if (!matSnap?.id) { console.error('Snapshot matriculados ausente'); process.exit(1); }

const [remat, doc, inad, bb, evasao, caaT0Map] = await Promise.all([
  loadIdSetFromBase('rematricula'),
  loadIdSetFromBase('docs-pendentes'),
  loadIdSetFromBase('inadimplentes-vencidos'),
  loadIdSetFromBase('acessos-blackboard'),
  loadIdSetFromBase('provavel-evasao'),
  caaProtocolsRepo.loadOpenCaaT0Map(),
]);

const fieldIds = getNovoCrmDealFieldIds();
const situacaoFieldId = String(fieldIds.situacao || '').trim();

const byCpf = new Map();
const byRgm = new Map();
await baseUploadRepo.forEachRowDataForSnapshot('matriculados', matSnap.id, (row) => {
  const m = extractMatriculadosMappedValues(row);
  const cpf = digits(m.cpf);
  const rgm = digits(m.rgm);
  if (cpf.length >= 11) keepBestRow(byCpf, cpf, row);
  if (rgm) keepBestRow(byRgm, rgm, row);
});

const cacheRows = await cacheRepo.listActiveCacheRowsForEnrichment({ scope: 'all_mapped', limit: 100000 });

let dealsScanned = 0;
let dealsMatched = 0;
let targetsSemRemat = 0;
let situacaoAlreadyCorrect = 0;
let situacaoWouldCorrect = 0;
let situacaoFieldMissing = 0;
const sampleWouldCorrect = [];

for (const row of cacheRows) {
  const deals = dealsFromCacheRow(row);
  if (!deals.length) continue;
  const cpfCache = digits(row.cpf_norm);

  for (const deal of deals) {
    dealsScanned += 1;
    const rgmDeal = digits(findCustom(deal, ['rgm']) || row.rgm_norm);
    const cpfDeal = digits(findCustom(deal, ['cpf']) || cpfCache);
    const matRow = (rgmDeal && byRgm.get(rgmDeal)) || (cpfDeal.length >= 11 && byCpf.get(cpfDeal)) || null;
    if (!matRow) continue;
    dealsMatched += 1;

    const mapped = extractMatriculadosMappedValues(matRow);
    const cpf = digits(mapped.cpf) || cpfDeal;
    const rgm = digits(mapped.rgm) || rgmDeal;
    const caaT0 = caaProtocolsRepo.lookupCaaT0(caaT0Map, cpf, rgm);
    const inCaaFresh = isCaaWithinRetencaoWindow(caaT0);

    const cl = classifyMatriculado(matRow, {
      inRematricula: inSet(remat, cpf, rgm),
      inCaaFresh,
      inDoc: inSet(doc, cpf, rgm),
      inInad: inSet(inad, cpf, rgm),
      inBb: inSet(bb, cpf, rgm),
      inEvasao: inSet(evasao, cpf, rgm),
    });

    if (cl.stageName !== 'Sem Rematricula') continue;
    targetsSemRemat += 1;

    if (!situacaoFieldId) {
      situacaoFieldMissing += 1;
      continue;
    }

    const curSituacao =
      readDealFieldById(deal, situacaoFieldId) ||
      findCustom(deal, ['situação', 'situacao', 'situação matrícula']);
    const curNorm = normalizeSituacaoCrm(curSituacao);

    if (curNorm === SITUACAO_CRM_SEM_REMATRICULA) {
      situacaoAlreadyCorrect += 1;
    } else {
      situacaoWouldCorrect += 1;
      if (sampleWouldCorrect.length < 10) {
        sampleWouldCorrect.push({
          dealId: deal.id,
          cpf,
          rgm,
          curSituacao: curSituacao || '(vazio)',
          curNorm: curNorm || '(vazio)',
          wouldWrite: SITUACAO_CRM_SEM_REMATRICULA,
        });
      }
    }
  }
}

console.log('\n=== Audit: Sem Rematricula — Situação carousel (READ-ONLY) ===');
console.log(`Deals escaneados:       ${dealsScanned}`);
console.log(`Deals matched mat:      ${dealsMatched}`);
console.log(`Alvo Sem Rematricula:   ${targetsSemRemat}`);
console.log(`Situação já correta:    ${situacaoAlreadyCorrect}`);
console.log(`Situação seria corrig.: ${situacaoWouldCorrect}  ← situacao_sem_remat_would_update`);
if (situacaoFieldMissing) console.log(`fieldId.situacao ausente: ${situacaoFieldMissing} (env NOVO_CRM_FIELD_SITUACAO não configurado)`);
if (sampleWouldCorrect.length) {
  console.log('\nSamples would-correct:');
  for (const s of sampleWouldCorrect) {
    console.log(`  deal=${s.dealId}  cpf=${s.cpf}  rgm=${s.rgm}  cur="${s.curSituacao}" → "${s.wouldWrite}"`);
  }
}
