/**
 * Realinha só etapa + Situação com regra remat/SIAA (sem reescrever todos os campos).
 *
 * - Ainda no remat + SIAA vivo → etapa Sem Rematrícula + Situação Sem Rematrícula
 * - Fora do remat → etapa classify (Grad/Pós/…) + Situação Em Curso/Cancelado…
 * - Cancelado/Trancado SIAA vence label remat
 *
 * Uso:
 *   node --env-file=.env scripts/novo-crm-remat-situacao-align.mjs --dry --max=500
 *   node --env-file=.env scripts/novo-crm-remat-situacao-align.mjs --apply
 */
import fs from 'node:fs';
import path from 'node:path';
import { applyNovoCrmProdIdsFromFile } from './_applyNovoCrmProdIds.mjs';
import * as baseUploadRepo from '../server/repositories/baseUploadRepository.js';
import * as cacheRepo from '../server/repositories/novoCrmPersonCacheRepository.js';
import * as caaProtocolsRepo from '../server/repositories/caaProtocolsRepository.js';
import {
  extractMatriculadosMappedValues,
  normalizeSituacaoCrm,
  resolveSituacaoCrm,
} from '../server/utils/novoCrmFieldMapping.js';
import {
  normalizeCpf,
  normalizeEmail,
  normalizePhone,
  normalizeRgm,
} from '../server/utils/novoCrmCacheNormalize.js';
import {
  classifyMatriculado,
  getNovoCrmDealFieldIds,
  getNovoCrmStageIds,
  isCaaWithinRetencaoWindow,
  isUntouchableStageId,
  stageNameFromId,
} from '../server/utils/novoCrmStageRules.js';
import { updateDeal, updateDealCustomFields } from '../server/services/novoCrmClient.js';
import { isNovoCrmWriteAllowedOnThisHost } from '../server/services/novoCrmMatriculadosProvisionService.js';

const args = process.argv.slice(2);
const apply = args.includes('--apply');
const maxArg = args.find((a) => a.startsWith('--max='));
const maxDeals = Math.min(
  Math.max(Number(maxArg?.split('=')[1]) || (apply ? 100000 : 2000), 1),
  100000
);
const concurrency = Math.min(
  Math.max(Number(process.env.NOVO_CRM_BACKFILL_CONCURRENCY || 3), 1),
  8
);

process.env.NOVO_CRM_ENABLED = '1';
process.env.NOVO_CRM_PROVISION_ALLOW_PROD = '1';
if (!process.env.NOVO_CRM_API_RATE_PER_SECOND) {
  process.env.NOVO_CRM_API_RATE_PER_SECOND = '4';
}

const ids = applyNovoCrmProdIdsFromFile();
const fieldIds = getNovoCrmDealFieldIds();
const stages = getNovoCrmStageIds();
const sitFieldId = String(fieldIds.situacao || '').trim();
const atualizadoId = String(fieldIds.atualizado || '').trim();
const retencaoStageId = String(stages.Retenção || '').trim();

const logPath = path.resolve(`data/remat-situacao-align-${Date.now()}.log`);
fs.mkdirSync('data', { recursive: true });
function log(...p) {
  const line = `[${new Date().toISOString()}] ${p.map(String).join(' ')}`;
  console.log(line);
  fs.appendFileSync(logPath, `${line}\n`);
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
  return Object.values(byId);
}

function keep(map, k, row) {
  if (k && !map.has(k)) map.set(k, row);
}

function identityInRemat(remat, identity) {
  if (identity.cpf && remat.cpf.has(identity.cpf)) return true;
  if (identity.rgm && remat.rgm.has(identity.rgm)) return true;
  if (identity.email && remat.email.has(identity.email)) return true;
  if (identity.phone && remat.phone.has(identity.phone)) return true;
  return false;
}

if (apply && !isNovoCrmWriteAllowedOnThisHost()) {
  log('ABORT write blocked');
  process.exit(1);
}
if (!sitFieldId) {
  log('ABORT situacao field id missing');
  process.exit(1);
}

log('START', JSON.stringify({ apply, maxDeals, concurrency, sitFieldId, atualizadoId: !!atualizadoId }));

const byCpf = new Map();
const byRgm = new Map();
const byEmail = new Map();
const byPhone = new Map();
const emailCount = new Map();
const phoneCount = new Map();
const matSnap = await baseUploadRepo.getLatestSnapshot('matriculados');
await baseUploadRepo.forEachRowDataForSnapshot('matriculados', matSnap.id, (row) => {
  const m = extractMatriculadosMappedValues(row);
  const cpf = normalizeCpf(m.cpf);
  const rgm = normalizeRgm(m.rgm);
  if (cpf) keep(byCpf, cpf, row);
  if (rgm) keep(byRgm, rgm, row);
  for (const e of [normalizeEmail(m._email), normalizeEmail(m.e_mail_ad)].filter(Boolean)) {
    emailCount.set(e, (emailCount.get(e) || 0) + 1);
    keep(byEmail, e, row);
  }
  const ph = normalizePhone(m._phone || m.telefone_comercial);
  if (ph) {
    phoneCount.set(ph, (phoneCount.get(ph) || 0) + 1);
    keep(byPhone, ph, row);
  }
});
for (const [e, n] of emailCount) if (n > 1) byEmail.delete(e);
for (const [p, n] of phoneCount) if (n > 1) byPhone.delete(p);

const remat = { cpf: new Set(), rgm: new Set(), email: new Set(), phone: new Set(), nRows: 0 };
const rematSnap = await baseUploadRepo.getLatestSnapshot('rematricula');
await baseUploadRepo.forEachRowDataForSnapshot('rematricula', rematSnap.id, (row) => {
  remat.nRows += 1;
  const cpf = normalizeCpf(row.CPF ?? row.cpf ?? row.Cpf);
  const rgm = normalizeRgm(row.RGM ?? row.rgm ?? row.Rgm ?? row.RGM_ALUN);
  const email = normalizeEmail(row.Email ?? row.email ?? row['E-mail']);
  const phone = normalizePhone(row.Telefone ?? row.Celular ?? row.phone);
  // enrich via mat if only rgm
  let eCpf = cpf;
  let eEmail = email;
  let ePhone = phone;
  const matR = (rgm && byRgm.get(rgm)) || (cpf && byCpf.get(cpf));
  if (matR) {
    const mm = extractMatriculadosMappedValues(matR);
    eCpf = eCpf || normalizeCpf(mm.cpf);
    eEmail = eEmail || normalizeEmail(mm._email) || normalizeEmail(mm.e_mail_ad);
    ePhone = ePhone || normalizePhone(mm._phone || mm.telefone_comercial);
  }
  if (eCpf) remat.cpf.add(eCpf);
  if (rgm) remat.rgm.add(rgm);
  if (eEmail) remat.email.add(eEmail);
  if (ePhone) remat.phone.add(ePhone);
});

const caaT0Map = await caaProtocolsRepo.loadOpenCaaT0Map();
const cacheRows = await cacheRepo.listActiveCacheRowsForEnrichment({
  scope: 'all_mapped',
  limit: 100000,
});

/** @type {Array<object>} */
const queue = [];
const byReason = {};

for (const row of cacheRows) {
  if (queue.length >= maxDeals) break;
  const deals = dealsFromCacheRow(row);
  const cpfCache = normalizeCpf(row.cpf_norm);
  const emailCache = normalizeEmail(row.email_norm);
  const phoneCache = normalizePhone(row.phone_norm);

  for (const deal of deals) {
    if (queue.length >= maxDeals) break;
    const dealId = String(deal.id || '').trim();
    if (!dealId) continue;
    const currentStageId = String(deal.stageId || '').trim() || null;
    if (!currentStageId) continue;

    const rgmDeal = normalizeRgm(findCustom(deal, ['rgm']) || row.rgm_norm);
    const cpfDeal = normalizeCpf(findCustom(deal, ['cpf']) || cpfCache);
    const matRow =
      (rgmDeal && byRgm.get(rgmDeal)) ||
      (cpfDeal && byCpf.get(cpfDeal)) ||
      (emailCache && byEmail.get(emailCache)) ||
      (phoneCache && byPhone.get(phoneCache)) ||
      null;
    if (!matRow) continue;

    const mapped = extractMatriculadosMappedValues(matRow);
    const identity = {
      cpf: normalizeCpf(mapped.cpf) || cpfDeal,
      rgm: normalizeRgm(mapped.rgm) || rgmDeal,
      email: normalizeEmail(mapped._email) || normalizeEmail(mapped.e_mail_ad) || emailCache,
      phone: normalizePhone(mapped._phone || mapped.telefone_comercial) || phoneCache,
    };
    const inRemat = identityInRemat(remat, identity);
    const caaT0 = caaProtocolsRepo.lookupCaaT0(caaT0Map, identity.cpf, identity.rgm);
    const inCaaFresh = isCaaWithinRetencaoWindow(caaT0);
    // Em Atendimento / Ganho / Cancelado: atualiza Situação; NÃO move etapa.
    // Retenção sem CAA open = manual — também não move.
    const stageLocked =
      isUntouchableStageId(currentStageId) ||
      (Boolean(retencaoStageId) && currentStageId === retencaoStageId && !inCaaFresh);

    const classification = classifyMatriculado(matRow, {
      inRematricula: inRemat,
      inCaaFresh,
    });
    const targetStageId = String(classification.stageId || '').trim();

    const curSit = findCustom(deal, ['situação', 'situacao', 'situação matrícula']);
    const targetSit = resolveSituacaoCrm(mapped.situacao || matRow['Situação Matrícula'], {
      inRematricula: inRemat,
    });
    const sitNeeds =
      Boolean(targetSit) &&
      normalizeSituacaoCrm(curSit) !== normalizeSituacaoCrm(targetSit);
    const stageNeeds =
      !stageLocked &&
      Boolean(classification.stageId) &&
      targetStageId !== currentStageId;

    if (!sitNeeds && !stageNeeds) continue;

    const reason = [
      stageNeeds
        ? `stage:${stageNameFromId(currentStageId) || '?'}→${classification.stageName}`
        : null,
      sitNeeds ? `sit:${curSit || '∅'}→${targetSit}` : null,
      inRemat ? 'in_remat' : 'out_remat',
    ]
      .filter(Boolean)
      .join('|');
    byReason[reason] = (byReason[reason] || 0) + 1;

    queue.push({
      dealId,
      cpf: identity.cpf,
      rgm: identity.rgm,
      fromStageId: currentStageId,
      toStageId: targetStageId,
      toStageName: classification.stageName,
      fromStageName: stageNameFromId(currentStageId),
      targetSit: sitNeeds ? targetSit : null,
      curSit,
      stageNeeds,
      sitNeeds,
      inRemat,
      reason,
    });
  }
}

log(
  `queue=${queue.length} by_reason=`,
  JSON.stringify(
    Object.fromEntries(Object.entries(byReason).sort((a, b) => b[1] - a[1]).slice(0, 25))
  )
);

if (!apply) {
  const summary = {
    ok: true,
    dry_run: true,
    queue: queue.length,
    by_reason: byReason,
    samples: queue.slice(0, 25),
    log: logPath,
  };
  fs.writeFileSync(logPath.replace(/\.log$/, '-summary.json'), JSON.stringify(summary, null, 2));
  log('DRY DONE', JSON.stringify({ queue: queue.length }));
  process.exit(0);
}

let writtenSit = 0;
let moved = 0;
let errors = 0;
const errorSamples = [];
let cursor = 0;
const started = Date.now();

async function worker() {
  while (true) {
    const i = cursor++;
    if (i >= queue.length) return;
    const item = queue[i];
    try {
      const values = [];
      if (item.sitNeeds && item.targetSit) {
        values.push({ fieldId: sitFieldId, value: item.targetSit });
      }
      if (atualizadoId && (item.sitNeeds || item.stageNeeds)) {
        values.push({ fieldId: atualizadoId, value: 'Sim' });
      }
      if (values.length) {
        await updateDealCustomFields(item.dealId, values, { maxRetries: 4 });
        if (item.sitNeeds) writtenSit += 1;
      }
      if (item.stageNeeds && item.toStageId) {
        await updateDeal(item.dealId, { stageId: item.toStageId });
        moved += 1;
      }
    } catch (err) {
      errors += 1;
      if (errorSamples.length < 15) {
        errorSamples.push({ dealId: item.dealId, error: String(err?.message || err) });
      }
    }
    if ((writtenSit + moved + errors) % 50 === 0 || i + 1 === queue.length) {
      const done = i + 1;
      const rate = done / Math.max((Date.now() - started) / 1000, 1);
      log(
        `progress ${done}/${queue.length} sit=${writtenSit} moved=${moved} errors=${errors} ~${rate.toFixed(1)}/s`
      );
    }
  }
}

await Promise.all(Array.from({ length: concurrency }, () => worker()));
const summary = {
  ok: errors < 100,
  dry_run: false,
  queue: queue.length,
  situacao_written: writtenSit,
  stages_moved: moved,
  errors,
  mins: Number(((Date.now() - started) / 60000).toFixed(2)),
  by_reason: byReason,
  error_samples: errorSamples,
  log: logPath,
};
fs.writeFileSync(logPath.replace(/\.log$/, '-summary.json'), JSON.stringify(summary, null, 2));
log('DONE', JSON.stringify(summary));
process.exit(summary.ok ? 0 : 2);
