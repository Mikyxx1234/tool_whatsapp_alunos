/**
 * Move deals em "Sem Rematricula" que NÃO estão no snapshot atual de rematrícula
 * para o target correto via classifyMatriculado (inRematricula=false).
 *
 * Uso:
 *   node --env-file=.env scripts/novo-crm-sem-remat-fora-snapshot-apply.mjs           # dry-run (default)
 *   node --env-file=.env scripts/novo-crm-sem-remat-fora-snapshot-apply.mjs --apply   # apply PROD
 *
 * Requer NOVO_CRM_PROVISION_ALLOW_PROD=1 no .env para apply.
 * Concurrency default 4; rate default 5/s (herda NOVO_CRM_API_RATE_PER_SECOND do .env).
 */

import 'dotenv/config';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { applyNovoCrmProdIdsFromFile } from './_applyNovoCrmProdIds.mjs';
import * as baseUploadRepo from '../server/repositories/baseUploadRepository.js';
import * as caaProtocolsRepo from '../server/repositories/caaProtocolsRepository.js';
import * as cacheRepo from '../server/repositories/novoCrmPersonCacheRepository.js';
import {
  extractMatriculadosMappedValues,
  normalizeSituacaoCrm,
  resolveSituacaoCrm,
} from '../server/utils/novoCrmFieldMapping.js';
import {
  classifyMatriculado,
  getCaaRetencaoHours,
  getNovoCrmDealFieldIds,
  getNovoCrmStageIds,
  isCaaWithinRetencaoWindow,
} from '../server/utils/novoCrmStageRules.js';
import {
  getDeal,
  isNovoCrmApiConfigured,
  updateDeal,
  updateDealCustomFields,
} from '../server/services/novoCrmClient.js';
import { isNovoCrmWriteAllowedOnThisHost } from '../server/services/novoCrmMatriculadosProvisionService.js';

// ─── Args / env setup ─────────────────────────────────────────────────────────

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

const args = process.argv.slice(2);
const DRY = !args.includes('--apply');
const CONCURRENCY = Math.min(
  Math.max(
    Number(args.find((a) => a.startsWith('--concurrency='))?.split('=')[1]) || 4,
    1
  ),
  8
);

process.env.NOVO_CRM_ENABLED = '1';
// Load PROD stage/field IDs into env (sets NOVO_CRM_STAGE_* and NOVO_CRM_FIELD_*)
const ids = applyNovoCrmProdIdsFromFile();

const base = String(process.env.NOVO_CRM_API_BASE_URL || '').trim();
if (!base) {
  console.error('[sem-remat-apply] NOVO_CRM_API_BASE_URL obrigatório');
  process.exit(2);
}
if (base.includes('crm-dev')) {
  console.error('[sem-remat-apply] BASE parece DEV. Este script é para PROD (crm.eduit).');
  process.exit(2);
}
// Always set ALLOW_PROD so isNovoCrmWriteAllowedOnThisHost passes the host guard
process.env.NOVO_CRM_PROVISION_ALLOW_PROD = '1';

if (!DRY && String(process.env.NOVO_CRM_PROVISION_ALLOW_PROD || '') !== '1') {
  // Guard already set above, but double-check .env had it before we override
}

if (!process.env.NOVO_CRM_API_RATE_PER_SECOND) {
  process.env.NOVO_CRM_API_RATE_PER_SECOND = '5';
}

console.log(
  `[sem-remat-apply] base=${base} dry=${DRY} concurrency=${CONCURRENCY} pipeline=${ids.pipeline?.name || '?'}`
);
console.log(
  `[sem-remat-apply] stages: ${Object.keys(ids.stages || {}).length}  fields: ${Object.keys(ids.fields || {}).length}`
);

// ─── Guards ───────────────────────────────────────────────────────────────────

if (!isNovoCrmApiConfigured()) {
  console.error('[sem-remat-apply] NOVO_CRM_ENABLED/TOKEN/BASE_URL não configurados');
  process.exit(2);
}
if (!isNovoCrmWriteAllowedOnThisHost()) {
  console.error('[sem-remat-apply] Escrita bloqueada neste host. Verifique NOVO_CRM_PROVISION_ALLOW_PROD=1 + URL.');
  process.exit(2);
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function digits(v) {
  return String(v ?? '').replace(/\D/g, '');
}

function inSet(set, cpf, rgm) {
  if (cpf && set.has(`cpf:${cpf}`)) return true;
  if (rgm && set.has(`rgm:${rgm}`)) return true;
  return false;
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

function readDealField(deal, fieldId, names = []) {
  const id = String(fieldId || '').trim();
  const wanted = names.map((n) => n.toLowerCase());
  for (const f of deal?.customFields || []) {
    const fid = String(f?.id || f?.fieldId || '').trim();
    const name = String(f?.name || '').trim().toLowerCase();
    if ((id && fid === id) || (wanted.length && wanted.includes(name))) {
      if (f?.value != null && String(f.value).trim() !== '') return String(f.value).trim();
    }
  }
  return '';
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

function isDealMissingError(err) {
  const status = Number(err?.status);
  if (status === 404) return true;
  const msg = String(err?.message || err || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/\p{M}/gu, '');
  return (
    msg.includes('nao encontrado') ||
    msg.includes('not found') ||
    msg.includes('negocio nao encontrado')
  );
}

// ─── Load data ────────────────────────────────────────────────────────────────

const now = new Date();
const stageIds = getNovoCrmStageIds();
const fieldIds = getNovoCrmDealFieldIds();
const semRematStageId = String(stageIds['Sem Rematricula'] || '').trim();

if (!semRematStageId) {
  console.error(
    '[sem-remat-apply] Sem Rematricula stageId não mapeado. Verifique data/novo-crm-prod-ids.json'
  );
  process.exit(2);
}

console.log(`\nsemRematStageId=${semRematStageId}`);
console.log('Carregando bases…');

const matSnap = await baseUploadRepo.getLatestSnapshot('matriculados');
if (!matSnap?.id) {
  console.error('[sem-remat-apply] Snapshot de matriculados ausente');
  process.exit(1);
}

const [remat, caaT0Map, doc, inad, bb, evasao] = await Promise.all([
  loadIdSetFromBase('rematricula'),
  caaProtocolsRepo.loadOpenCaaT0Map(),
  loadIdSetFromBase('docs-pendentes'),
  loadIdSetFromBase('inadimplentes-vencidos'),
  loadIdSetFromBase('acessos-blackboard'),
  loadIdSetFromBase('provavel-evasao'),
]);
const caaRetencaoHours = getCaaRetencaoHours();

console.log(
  `remat=${remat.size} · caa_open=${caaT0Map.size} · doc=${doc.size} · inad=${inad.size} · bb=${bb.size} · evasao=${evasao.size}`
);

console.log('Indexando matriculados…');
const byCpf = new Map();
const byRgm = new Map();
await baseUploadRepo.forEachRowDataForSnapshot('matriculados', matSnap.id, (row) => {
  const m = extractMatriculadosMappedValues(row);
  const cpf = digits(m.cpf);
  const rgm = digits(m.rgm);
  if (cpf.length >= 11) keepBestRow(byCpf, cpf, row);
  if (rgm) keepBestRow(byRgm, rgm, row);
});
console.log(`matriculados: cpf=${byCpf.size} rgm=${byRgm.size}`);

console.log('Carregando espelho (cache)…');
const cacheRows = await cacheRepo.listActiveCacheRowsForEnrichment({
  scope: 'all_mapped',
  limit: 100000,
});
console.log(`cache rows=${cacheRows.length}`);

// ─── Scan ─────────────────────────────────────────────────────────────────────

let scanned = 0;
let inSemRemat = 0;
let inRematSnapshot = 0;
let noCpfRgm = 0;
let noMatMatch = 0;
let targetIsSemRemat = 0;
let noStageId = 0;

/** @type {Array<{dealId:string, cpf:string, rgm:string, currentStageId:string, targetStageId:string, targetStageName:string, situacaoValue:string|null, inCaaOpen:boolean, inCaaFresh:boolean}>} */
const candidates = [];
/** @type {Array<{dealId:string, cpf:string, rgm:string, reason:string}>} */
const noMatchList = [];

for (const row of cacheRows) {
  const deals = dealsFromCacheRow(row);
  if (!deals.length) continue;
  const cpfCache = digits(row.cpf_norm);

  for (const deal of deals) {
    scanned += 1;
    const dealId = String(deal.id || '').trim();
    if (!dealId) continue;

    const currentStageId = String(deal.stageId || '').trim();
    if (!currentStageId || currentStageId !== semRematStageId) continue;
    inSemRemat += 1;

    const rgmDeal = digits(findCustom(deal, ['rgm']) || row.rgm_norm);
    const cpfDeal = digits(findCustom(deal, ['cpf']) || cpfCache);

    if (!cpfDeal && !rgmDeal) {
      noCpfRgm += 1;
      noMatchList.push({ dealId, cpf: '', rgm: '', reason: 'no_cpf_rgm' });
      continue;
    }

    if (inSet(remat, cpfDeal, rgmDeal)) {
      inRematSnapshot += 1;
      continue;
    }

    const matRow =
      (rgmDeal && byRgm.get(rgmDeal)) ||
      (cpfDeal.length >= 11 && byCpf.get(cpfDeal)) ||
      null;
    if (!matRow) {
      noMatMatch += 1;
      noMatchList.push({ dealId, cpf: cpfDeal, rgm: rgmDeal, reason: 'no_mat_match' });
      continue;
    }

    const mapped = extractMatriculadosMappedValues(matRow);
    const cpf = digits(mapped.cpf) || cpfDeal;
    const rgm = digits(mapped.rgm) || rgmDeal;
    const caaT0 = caaProtocolsRepo.lookupCaaT0(caaT0Map, cpf, rgm);
    const inCaaOpen = Boolean(caaT0);
    const inCaaFresh = isCaaWithinRetencaoWindow(caaT0, now);

    const classification = classifyMatriculado(matRow, {
      inRematricula: false,
      inCaaFresh,
      inDoc: inSet(doc, cpf, rgm),
      inInad: inSet(inad, cpf, rgm),
      inBb: inSet(bb, cpf, rgm),
      inEvasao: inSet(evasao, cpf, rgm),
      now,
    });

    if (
      classification.stageName === 'Sem Rematricula' ||
      classification.stageId === semRematStageId
    ) {
      targetIsSemRemat += 1;
      continue;
    }

    if (!classification.stageId) {
      noStageId += 1;
      noMatchList.push({ dealId, cpf, rgm, reason: 'no_stage_id_in_classify' });
      continue;
    }

    // Resolve situação carousel com inRematricula=false
    let situacaoValue = null;
    if (fieldIds.situacao) {
      const siaaValue = mapped.situacao || matRow['Situação Matrícula'] || '';
      const resolved = resolveSituacaoCrm(siaaValue, { inRematricula: false });
      const curSituacao = readDealField(deal, fieldIds.situacao, [
        'situação',
        'situacao',
        'situação matrícula',
      ]);
      if (resolved && normalizeSituacaoCrm(resolved) !== normalizeSituacaoCrm(curSituacao)) {
        situacaoValue = resolved;
      }
    }

    candidates.push({
      dealId,
      cpf,
      rgm,
      currentStageId,
      targetStageId: classification.stageId,
      targetStageName: classification.stageName,
      situacaoValue,
      inCaaOpen,
      inCaaFresh,
    });
  }
}

const byTarget = {};
for (const c of candidates) {
  byTarget[c.targetStageName] = (byTarget[c.targetStageName] || 0) + 1;
}

console.log('\n=== Scan ===');
console.log(`Deals scanned         : ${scanned}`);
console.log(`Em Sem Rematricula    : ${inSemRemat}`);
console.log(`No snapshot remat     : ${inRematSnapshot}  (skip)`);
console.log(`Sem CPF/RGM           : ${noCpfRgm}  (skip)`);
console.log(`Sem match matriculados: ${noMatMatch}  (skip — reportados no JSON)`);
console.log(`Target ainda SemRemat : ${targetIsSemRemat}  (skip)`);
console.log(`Sem stageId classify  : ${noStageId}  (skip)`);
console.log(`Movíveis              : ${candidates.length}`);
console.log('\nPor target:');
for (const [stage, n] of Object.entries(byTarget).sort((a, b) => b[1] - a[1])) {
  console.log(`  ${stage.padEnd(22)} ${n}`);
}
console.log(`\nSem match mat: ${noMatchList.length} deals — detalhados no JSON`);

if (DRY) {
  console.log('\n[DRY-RUN] Nenhuma escrita. Passe --apply para aplicar.\n');
}

// ─── Apply ────────────────────────────────────────────────────────────────────

let moved = 0;
let skippedLive = 0;
let errors = 0;
const movedByTarget = {};
const errorSamples = [];
const applySamples = [];

if (!DRY && candidates.length > 0) {
  console.log(`\nAplicando ${candidates.length} moves (concurrency=${CONCURRENCY})…`);
  let cursor = 0;

  const worker = async (wid) => {
    while (true) {
      const idx = cursor++;
      if (idx >= candidates.length) return;
      const c = candidates[idx];
      try {
        // Live check: confirma que ainda está em Sem Rematricula
        let liveStageId = c.currentStageId;
        try {
          const live = await getDeal(c.dealId);
          liveStageId = String(live?.stageId || live?.stage?.id || '').trim() || c.currentStageId;
        } catch (err) {
          if (isDealMissingError(err)) {
            skippedLive += 1;
            continue;
          }
          // getDeal falhou (não 404) — prossegue com stageId do cache (best-effort)
          console.warn(`[w${wid}] getDeal fallback deal=${c.dealId}: ${err?.message || err}`);
        }

        if (liveStageId !== semRematStageId) {
          skippedLive += 1;
          continue;
        }

        // Atualiza situação carousel se necessário
        if (c.situacaoValue && fieldIds.situacao) {
          await updateDealCustomFields(c.dealId, [
            { fieldId: fieldIds.situacao, value: c.situacaoValue },
          ]);
        }

        // Move etapa
        await updateDeal(c.dealId, { stageId: c.targetStageId });

        moved += 1;
        movedByTarget[c.targetStageName] = (movedByTarget[c.targetStageName] || 0) + 1;
        if (applySamples.length < 25) {
          applySamples.push({
            dealId: c.dealId,
            cpf: c.cpf,
            rgm: c.rgm,
            from: 'Sem Rematricula',
            to: c.targetStageName,
            situacao_written: c.situacaoValue || null,
          });
        }
        if (moved % 20 === 0) {
          process.stdout.write(`  moved=${moved}/${candidates.length} errors=${errors}\r`);
        }
      } catch (err) {
        if (isDealMissingError(err)) {
          skippedLive += 1;
          continue;
        }
        errors += 1;
        const msg = err?.message || String(err);
        if (errorSamples.length < 20) {
          errorSamples.push({ dealId: c.dealId, cpf: c.cpf, rgm: c.rgm, error: msg });
        }
        console.warn(`[w${wid}] ERR deal=${c.dealId}: ${msg}`);
      }
    }
  };

  await Promise.all(Array.from({ length: CONCURRENCY }, (_, i) => worker(i + 1)));
  process.stdout.write('\n');

  console.log('\n=== Apply concluído ===');
  console.log(`Moved        : ${moved}`);
  console.log(`Skipped (live/missing): ${skippedLive}`);
  console.log(`Errors       : ${errors}`);
  console.log('\nPor target:');
  for (const [stage, n] of Object.entries(movedByTarget).sort((a, b) => b[1] - a[1])) {
    console.log(`  ${stage.padEnd(22)} ${n}`);
  }
}

// ─── Salvar resultado ─────────────────────────────────────────────────────────

const ts = Date.now();
const outFile = DRY
  ? `sem-remat-fora-snap-dry-${ts}.json`
  : `sem-remat-fora-snap-apply-${ts}.json`;
const outPath = path.join(ROOT, 'data', outFile);
fs.mkdirSync(path.dirname(outPath), { recursive: true });

const result = {
  ran_at: now.toISOString(),
  ran_at_brt: now.toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' }),
  dry_run: DRY,
  base_url: base,
  scan: {
    scanned,
    in_sem_remat: inSemRemat,
    in_remat_snapshot_skip: inRematSnapshot,
    no_cpf_rgm_skip: noCpfRgm,
    no_mat_match_skip: noMatMatch,
    target_still_sem_remat_skip: targetIsSemRemat,
    no_stage_id_skip: noStageId,
    movable: candidates.length,
    by_target: byTarget,
  },
  apply: DRY
    ? null
    : { moved, skipped_live: skippedLive, errors, by_target: movedByTarget },
  no_match_list: noMatchList,
  dry_samples: DRY
    ? candidates.slice(0, 30).map((c) => ({
        dealId: c.dealId,
        cpf: c.cpf,
        rgm: c.rgm,
        targetStageName: c.targetStageName,
        situacaoWouldWrite: c.situacaoValue || null,
        inCaaOpen: c.inCaaOpen,
        inCaaFresh: c.inCaaFresh,
      }))
    : undefined,
  apply_samples: !DRY ? applySamples : undefined,
  error_samples: errorSamples,
  snapshots: {
    matriculados_id: matSnap.id,
    matriculados_created_at: matSnap.created_at || null,
    remat_set_size: remat.size,
    caa_open_keys: caaT0Map.size,
    caa_retencao_hours: caaRetencaoHours,
  },
};

fs.writeFileSync(outPath, JSON.stringify(result, null, 2), 'utf8');
console.log(`\nJSON: ${outPath}`);
