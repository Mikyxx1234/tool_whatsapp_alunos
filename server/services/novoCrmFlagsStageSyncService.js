/**
 * Sync diário/manual de matriculados → deals já existentes no Novo CRM.
 *
 * Modes:
 *   flags_stage — atualiza as 4 flags (Sim/Não) + move etapa (respeitando intocáveis)
 *   fields      — sobrescreve campos SIAA (curso/polo/situação/email/rgm/cpf/nasc)
 *   both        — fields + flags_stage
 *
 * Intocáveis (não move etapa): Ganho, Cancelado; Retenção sem CAA open (manual).
 * CAA open ≤72h → Retenção; após 72h segue SIAA (pode sair de Retenção).
 * Apply otimizado: só reescreve flag quando (a) valor conhecido diverge, ou
 * (b) campo vazio e próximo=Sim (não grava vazio→Não — evita flood de PUTs).
 *
 * Entrada + saída (31/07/2026): o relatório do dia é a verdade. O loop
 * principal (entrada) preenche/corrige quem TEM matRow. Um passo INVERSO
 * varre TODOS os deals do cache com flag=Sim / etapa Sem Rematricula e
 * fecha quem SAIU da base (merge por dealId com a fila do loop principal):
 *   - Flags (doc/inad/bb/evasao): cache=Sim + identidade fora do índice → Não.
 *   - Sem Rematricula: fora do remat + tem matRow → classifyMatriculado(false).
 * Identidade = cpf/rgm; email/phone só se ÚNICOS no relatório. Sanity: se
 * `nRows < NOVO_CRM_FLAGS_EXIT_SANITY_RATIO * simCount` (ou nRows=0), a saída
 * daquela fila é pulada (upload incompleto).
 */

import { randomUUID } from 'node:crypto';
import * as baseUploadRepo from '../repositories/baseUploadRepository.js';
import * as caaProtocolsRepo from '../repositories/caaProtocolsRepository.js';
import * as cacheRepo from '../repositories/novoCrmPersonCacheRepository.js';
import {
  normalizeCpf,
  normalizeEmail,
  normalizePhone,
  normalizeRgm,
} from '../utils/novoCrmCacheNormalize.js';
import {
  extractMatriculadosMappedValues,
  normalizeSituacaoCrm,
  resolveSituacaoCrm,
  SITUACAO_CRM_SEM_REMATRICULA,
} from '../utils/novoCrmFieldMapping.js';
import {
  classifyMatriculado,
  getCaaRetencaoHours,
  getNovoCrmDealFieldIds,
  getNovoCrmStageIds,
  isCaaWithinRetencaoWindow,
  isUntouchableStageId,
  stageNameFromId,
  titleCasePolo,
} from '../utils/novoCrmStageRules.js';
import {
  getDeal,
  isNovoCrmApiConfigured,
  updateDeal,
  updateDealCustomFields,
} from './novoCrmClient.js';
import { isNovoCrmWriteAllowedOnThisHost } from './novoCrmMatriculadosProvisionService.js';

function digits(v) {
  return String(v ?? '').replace(/\D/g, '');
}

function simNao(v) {
  return v ? 'Sim' : 'Não';
}

/**
 * Índice de identidade de uma base satélite (rematrícula/docs/inad/bb/evasão).
 * cpf/rgm sempre entram; email/phone só entram se ÚNICOS no relatório
 * (repetido = ambíguo, não usar pra match). `nRows` = linhas do snapshot,
 * usado no guard de sanity da saída (não zerar tudo por upload incompleto).
 * @typedef {{ cpf: Set<string>, rgm: Set<string>, email: Set<string>, phone: Set<string>, nRows: number }} IdentityIndex
 */

/** @returns {{cpf:string,rgm:string,email:string,phone:string}} */
function pickIdentityFromRow(row) {
  return {
    cpf: normalizeCpf(row.CPF ?? row.cpf ?? row.Cpf),
    rgm: normalizeRgm(row.RGM ?? row.rgm ?? row.Rgm),
    email: normalizeEmail(row.Email ?? row['E-mail'] ?? row.email ?? row['e-mail']),
    phone: normalizePhone(
      row.Telefone ?? row.Celular ?? row['Fone celular'] ?? row['Fone Celular'] ?? row.phone
    ),
  };
}

/** @returns {Promise<IdentityIndex>} */
async function loadIdentityIndexFromBase(category) {
  /** @type {IdentityIndex} */
  const index = { cpf: new Set(), rgm: new Set(), email: new Set(), phone: new Set(), nRows: 0 };
  const snap = await baseUploadRepo.getLatestSnapshot(category);
  if (!snap?.id) return index;
  const emailCount = new Map();
  const phoneCount = new Map();
  await baseUploadRepo.forEachRowDataForSnapshot(category, snap.id, (row) => {
    index.nRows += 1;
    const id = pickIdentityFromRow(row);
    if (id.cpf) index.cpf.add(id.cpf);
    if (id.rgm) index.rgm.add(id.rgm);
    if (id.email) emailCount.set(id.email, (emailCount.get(id.email) || 0) + 1);
    if (id.phone) phoneCount.set(id.phone, (phoneCount.get(id.phone) || 0) + 1);
  });
  for (const [email, n] of emailCount) if (n === 1) index.email.add(email);
  for (const [phone, n] of phoneCount) if (n === 1) index.phone.add(phone);
  return index;
}

/**
 * @param {IdentityIndex} index
 * @param {{cpf?:string, rgm?:string, email?:string, phone?:string}} identity
 */
function identityInIndex(index, identity = {}) {
  if (!index) return false;
  const { cpf, rgm, email, phone } = identity;
  if (cpf && index.cpf.has(cpf)) return true;
  if (rgm && index.rgm.has(rgm)) return true;
  if (email && index.email.has(email)) return true;
  if (phone && index.phone.has(phone)) return true;
  return false;
}

/** Ratio mínimo nRows/simCount pra permitir saída (Sim→Não / sair de Sem Rematricula). */
function flagsExitSanityRatio() {
  const v = Number(process.env.NOVO_CRM_FLAGS_EXIT_SANITY_RATIO);
  if (!Number.isFinite(v)) return 0.7;
  return Math.min(Math.max(v, 0), 1);
}

/** Normaliza valor de flag CRM para comparar Sim/Não. */
function normFlagValue(v) {
  const s = String(v ?? '')
    .trim()
    .toLowerCase()
    .normalize('NFD')
    .replace(/\p{M}/gu, '');
  if (!s) return '';
  if (s === 'sim' || s === 'true' || s === '1' || s === 'yes') return 'sim';
  if (s === 'nao' || s === 'false' || s === '0' || s === 'no') return 'nao';
  return s;
}

/**
 * Lê valor de custom field no deal do cache (por id e/ou nome).
 * @param {object} deal
 * @param {string} fieldId
 * @param {string[]} names
 */
function readDealField(deal, fieldId, names = []) {
  const id = String(fieldId || '').trim();
  const wanted = names.map((n) => n.toLowerCase());
  for (const f of deal?.customFields || []) {
    const fid = String(f?.id || f?.fieldId || '').trim();
    const name = String(f?.name || '')
      .trim()
      .toLowerCase();
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

/** Mantém a melhor linha por chave (EM CURSO vence CANCELADO). */
function keepBestRow(map, key, row) {
  if (!key) return;
  const prev = map.get(key);
  if (!prev || situacaoRank(row) < situacaoRank(prev)) map.set(key, row);
}

function maxErrorsBeforeAbort() {
  // Cap alto: ghost deals no cache (404) não contam — ver isDealMissingError.
  return Math.min(Math.max(Number(process.env.NOVO_CRM_FLAGS_SYNC_MAX_ERRORS) || 50, 5), 2000);
}

/** Workers paralelos no apply (rate limit global do client ainda vale). Default 5 (anti-429 vs throughput). */
function flagsSyncConcurrency() {
  return Math.min(Math.max(Number(process.env.NOVO_CRM_FLAGS_SYNC_CONCURRENCY) || 5, 1), 24);
}

/**
 * getDeal live antes de mover? Default OFF — confia no stageId do espelho
 * (Full Sync noturno). Ligue NOVO_CRM_FLAGS_SYNC_LIVE_STAGE=1 se quiser revalidar.
 */
function flagsSyncLiveStage() {
  const v = String(process.env.NOVO_CRM_FLAGS_SYNC_LIVE_STAGE || '').trim();
  return v === '1' || v === 'true';
}

/** Deal apagado no CRM mas ainda no espelho local — skip, não abort. */
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
    // stageId null → fail-closed no move (não movemos sem saber a etapa).
    return [{ id: String(row.primary_deal_id), stageId: null, customFields: [] }];
  }
  return [];
}

/**
 * @param {{ dryRun?: boolean, mode?: 'flags_stage'|'fields'|'both', maxDeals?: number, jobId?: string|null }} [opts]
 */
export async function runFlagsStageSync(opts = {}) {
  const dryRun = opts.dryRun === true;
  const mode = ['flags_stage', 'fields', 'both'].includes(opts.mode) ? opts.mode : 'flags_stage';
  const doFlags = mode === 'flags_stage' || mode === 'both';
  const doFields = mode === 'fields' || mode === 'both';
  const maxDeals = Math.min(Math.max(Number(opts.maxDeals) || 50000, 1), 100000);
  const jobId = opts.jobId || null;
  const errorBudget = maxErrorsBeforeAbort();
  let aborted = false;
  let abortReason = null;

  if (!isNovoCrmApiConfigured()) {
    const err = new Error('NOVO_CRM_ENABLED/TOKEN/BASE_URL não configurados');
    err.status = 503;
    throw err;
  }
  if (!isNovoCrmWriteAllowedOnThisHost()) {
    const err = new Error(
      'Sync fields/flags bloqueado neste host. Use CRM DEV ou NOVO_CRM_PROVISION_ALLOW_PROD=1 + NOVO_CRM_API_BASE_URL explícita.'
    );
    err.status = 403;
    throw err;
  }

  const patchJob = (p) => {
    if (!jobId) return;
    const j = jobs.get(jobId);
    if (j) Object.assign(j, p);
  };

  const matSnap = await baseUploadRepo.getLatestSnapshot('matriculados');
  if (!matSnap?.id) {
    const err = new Error('Snapshot de matriculados ausente');
    err.status = 400;
    throw err;
  }

  patchJob({ phase: 'loading_bases', status_message: 'Carregando bases…' });

  const [remat, caaT0Map, doc, inad, bb, evasao] = await Promise.all([
    loadIdentityIndexFromBase('rematricula'),
    caaProtocolsRepo.loadOpenCaaT0Map(),
    loadIdentityIndexFromBase('docs-pendentes'),
    loadIdentityIndexFromBase('inadimplentes-vencidos'),
    loadIdentityIndexFromBase('acessos-blackboard'),
    loadIdentityIndexFromBase('provavel-evasao'),
  ]);
  const caaRetencaoHours = getCaaRetencaoHours();
  const stageIds = getNovoCrmStageIds();
  const retencaoStageId = String(stageIds.Retenção || '').trim();
  const semRematStageId = String(stageIds['Sem Rematricula'] || '').trim();

  /** @type {Map<string, Record<string, unknown>>} */
  const byCpf = new Map();
  /** @type {Map<string, Record<string, unknown>>} */
  const byRgm = new Map();
  /** @type {Map<string, Record<string, unknown>>} — só e-mails únicos no relatório */
  const byEmail = new Map();
  /** @type {Map<string, Record<string, unknown>>} — só telefones únicos no relatório */
  const byPhone = new Map();
  const emailRowCount = new Map();
  const phoneRowCount = new Map();
  await baseUploadRepo.forEachRowDataForSnapshot('matriculados', matSnap.id, (row) => {
    const m = extractMatriculadosMappedValues(row);
    const cpf = digits(m.cpf);
    const rgm = digits(m.rgm);
    if (cpf.length >= 11) keepBestRow(byCpf, cpf, row);
    if (rgm) keepBestRow(byRgm, rgm, row);
    const rowEmails = new Set([normalizeEmail(m._email), normalizeEmail(m.e_mail_ad)].filter(Boolean));
    for (const email of rowEmails) {
      emailRowCount.set(email, (emailRowCount.get(email) || 0) + 1);
      keepBestRow(byEmail, email, row);
    }
    const phone = normalizePhone(m._phone);
    if (phone) {
      phoneRowCount.set(phone, (phoneRowCount.get(phone) || 0) + 1);
      keepBestRow(byPhone, phone, row);
    }
  });
  for (const [email, n] of emailRowCount) if (n > 1) byEmail.delete(email);
  for (const [phone, n] of phoneRowCount) if (n > 1) byPhone.delete(phone);

  patchJob({ phase: 'loading_cache', status_message: 'Carregando espelho local…' });
  const cacheRows = await cacheRepo.listActiveCacheRowsForEnrichment({
    scope: 'all_mapped',
    limit: 100000,
  });

  const fieldIds = getNovoCrmDealFieldIds();
  let scanned = 0;
  let matched = 0;
  let flagsUpdated = 0;
  let stagesMoved = 0;
  let stagesSkippedUntouchable = 0;
  let stagesSkippedUnknown = 0;
  let fieldsUpdated = 0;
  let skippedNoMatch = 0;
  let skippedNoDeal = 0;
  let skippedMissing = 0;
  let skippedUnchanged = 0;
  let situacaoSemRematUpdated = 0;
  let situacaoSemRematWouldUpdate = 0;
  let errors = 0;
  const liveStage = flagsSyncLiveStage();
  const concurrency = dryRun ? 1 : flagsSyncConcurrency();
  /** @type {Record<string, number>} */
  const stagesByTarget = {};
  /** @type {Array<object>} */
  const samples = [];
  /** @type {Array<object>} */
  const errorSamples = [];
  /** @type {Array<object>} */
  const workQueue = [];
  let flagsExitCleared = 0;
  let stagesExitRemat = 0;
  /** @type {Record<string, number>} */
  const exitSkippedSanity = {};

  const noteError = (sample) => {
    errors += 1;
    if (errorSamples.length < 15) errorSamples.push(sample);
    if (errors >= errorBudget && !aborted) {
      aborted = true;
      abortReason = `abort após ${errors} erros`;
      console.error(`[novo-crm-flags-sync] ${abortReason}`);
    }
  };

  const noteMissing = (dealId, cpf) => {
    skippedMissing += 1;
    if (skippedMissing <= 5 || skippedMissing % 100 === 0) {
      console.warn(
        `[novo-crm-flags-sync] SKIP missing deal=${dealId} cpf=${cpf || '?'} (total=${skippedMissing})`
      );
    }
  };

  patchJob({
    phase: 'processing',
    status_message: 'Processando deals…',
    total: cacheRows.length,
  });

  outer: for (const row of cacheRows) {
    if (aborted) break;
    const deals = dealsFromCacheRow(row);
    if (!deals.length) {
      skippedNoDeal += 1;
      continue;
    }

    const cpfCache = digits(row.cpf_norm);
    const emailCache = normalizeEmail(row.email_norm);
    const phoneCache = normalizePhone(row.phone_norm);

    for (const deal of deals) {
      if (aborted || scanned >= maxDeals) break outer;
      scanned += 1;
      if (scanned % 100 === 0) {
        patchJob({
          processed: scanned,
          sent: flagsUpdated + stagesMoved + fieldsUpdated,
          status_message: `Processados ${scanned}…`,
        });
      }

      const dealId = String(deal.id || '').trim();
      if (!dealId) continue;

      const rgmDeal = digits(findCustom(deal, ['rgm']) || row.rgm_norm);
      const cpfDeal = digits(findCustom(deal, ['cpf']) || cpfCache);
      const matRow =
        (rgmDeal && byRgm.get(rgmDeal)) ||
        (cpfDeal.length >= 11 && byCpf.get(cpfDeal)) ||
        (emailCache && byEmail.get(emailCache)) ||
        (phoneCache && byPhone.get(phoneCache)) ||
        null;
      if (!matRow) {
        skippedNoMatch += 1;
        continue;
      }
      matched += 1;

      const mapped = extractMatriculadosMappedValues(matRow);
      const cpf = digits(mapped.cpf) || cpfDeal;
      const rgm = digits(mapped.rgm) || rgmDeal;
      const emailForMatch = normalizeEmail(mapped._email) || normalizeEmail(mapped.e_mail_ad);
      const phoneForMatch = normalizePhone(mapped._phone || mapped.telefone_comercial);
      const identity = {
        cpf: normalizeCpf(cpf),
        rgm: normalizeRgm(rgm),
        email: emailForMatch,
        phone: phoneForMatch,
      };
      const caaT0 = caaProtocolsRepo.lookupCaaT0(caaT0Map, cpf, rgm);
      const inCaaOpen = Boolean(caaT0);
      const inCaaFresh = isCaaWithinRetencaoWindow(caaT0);
      const classification = classifyMatriculado(matRow, {
        inRematricula: identityInIndex(remat, identity),
        inCaaFresh,
        inDoc: identityInIndex(doc, identity),
        inInad: identityInIndex(inad, identity),
        inBb: identityInIndex(bb, identity),
        inEvasao: identityInIndex(evasao, identity),
      });
      stagesByTarget[classification.stageName] =
        (stagesByTarget[classification.stageName] || 0) + 1;

      // Cache stageId — se ausente, fail-closed (não move).
      let currentStageId = String(deal.stageId || '').trim() || null;

      /** @type {Array<{fieldId:string,value:string}>} */
      const flagValues = [];
      if (doFlags) {
        const flagPairs = [
          [
            fieldIds.doc_pendentes,
            simNao(classification.flags.doc_pendentes),
            ['doc pendentes', 'doc_pendentes', 'docpendente'],
          ],
          [
            fieldIds.inadimplente,
            simNao(classification.flags.inadimplente),
            // PROD usa o custom field `situacaofinanceira` (não existe `inadimplente`).
            ['inadimplente', 'situacaofinanceira', 'situacao financeira', 'financeiro'],
          ],
          [
            fieldIds.acessoblack,
            simNao(classification.flags.acessoblack),
            ['acessoblack', 'acesso black'],
          ],
          [fieldIds.evasao, simNao(classification.flags.evasao), ['evasao', 'evasão']],
        ];
        for (const [fieldId, value, names] of flagPairs) {
          if (!fieldId) continue;
          const cur = normFlagValue(readDealField(deal, fieldId, names));
          const next = normFlagValue(value);
          // Política (31/07/2026):
          // - vazio + próximo=Sim → preenche (corrige subcontagem vs bases)
          // - vazio + próximo=Não → NÃO grava (evita 4 PUTs × N deals = gargalo antigo)
          // - já tem valor e diverge → corrige
          if (cur === next) continue;
          if (!cur && next !== 'sim') continue;
          flagValues.push({ fieldId, value });
        }
      }

      /** @type {Array<{fieldId:string,value:string}>} */
      const fieldValues = [];
      if (doFields) {
        if (digits(mapped.cpf) && fieldIds.cpf) {
          fieldValues.push({ fieldId: fieldIds.cpf, value: digits(mapped.cpf) });
        }
        if (digits(mapped.rgm) && fieldIds.rgm) {
          fieldValues.push({ fieldId: fieldIds.rgm, value: digits(mapped.rgm) });
        }
        if (mapped.curso && fieldIds.curso) {
          fieldValues.push({ fieldId: fieldIds.curso, value: mapped.curso });
        }
        if (mapped.polo && fieldIds.polo) {
          fieldValues.push({
            fieldId: fieldIds.polo,
            value: titleCasePolo(mapped.polo) || mapped.polo,
          });
        }
        const situacao = resolveSituacaoCrm(
          mapped.situacao || matRow['Situação Matrícula'],
          { inRematricula: identityInIndex(remat, identity) }
        );
        if (situacao && fieldIds.situacao) {
          fieldValues.push({ fieldId: fieldIds.situacao, value: situacao });
        }
        if (mapped.nivel && fieldIds.nivel) {
          fieldValues.push({ fieldId: fieldIds.nivel, value: mapped.nivel });
        }
        if (mapped._email && fieldIds.email) {
          fieldValues.push({ fieldId: fieldIds.email, value: mapped._email });
        }
        if (mapped.e_mail_ad && fieldIds.email_ad) {
          fieldValues.push({ fieldId: fieldIds.email_ad, value: mapped.e_mail_ad });
        }
        if (matRow['Data Nascimento'] && fieldIds.nasc) {
          fieldValues.push({
            fieldId: fieldIds.nasc,
            value: String(matRow['Data Nascimento']).slice(0, 10),
          });
        }
      }

      // Sem Rematricula: sincroniza carousel Situação junto com a etapa,
      // mesmo com doFields=false. Evita escrita se já canônico no cache.
      const semRematSituacaoValues = [];
      if (doFlags && classification.stageName === 'Sem Rematricula' && fieldIds.situacao) {
        const alreadyInFieldValues = doFields && fieldValues.some((fv) => fv.fieldId === fieldIds.situacao);
        if (!alreadyInFieldValues) {
          const curSituacao = readDealField(deal, fieldIds.situacao, ['situação', 'situacao', 'situação matrícula']);
          if (normalizeSituacaoCrm(curSituacao) !== SITUACAO_CRM_SEM_REMATRICULA) {
            semRematSituacaoValues.push({ fieldId: fieldIds.situacao, value: SITUACAO_CRM_SEM_REMATRICULA });
          }
        }
      }

      const values = [...flagValues, ...fieldValues, ...semRematSituacaoValues];

      /**
       * @param {string|null} stageId
       * @param {boolean} caaOpen
       */
      const decideMove = (stageId, caaOpen) => {
        if (!doFlags || !classification.stageId) {
          return { move: false, untouchable: false, unknown: false };
        }
        if (!stageId) return { move: false, untouchable: false, unknown: true };
        if (isUntouchableStageId(stageId)) {
          return { move: false, untouchable: true, unknown: false };
        }
        // Retenção sem CAA open = manual / outra automação — não mexe.
        if (retencaoStageId && stageId === retencaoStageId && !caaOpen) {
          return { move: false, untouchable: true, unknown: false };
        }
        if (classification.stageId === stageId) {
          return { move: false, untouchable: false, unknown: false };
        }
        return { move: true, untouchable: false, unknown: false };
      };

      if (dryRun) {
        const d = decideMove(currentStageId, inCaaOpen);
        if (doFlags && flagValues.length) flagsUpdated += 1;
        if (doFields && fieldValues.length) fieldsUpdated += 1;
        if (semRematSituacaoValues.length) situacaoSemRematWouldUpdate += 1;
        if (!flagValues.length && !fieldValues.length && !semRematSituacaoValues.length && !d.move) skippedUnchanged += 1;
        if (d.move) stagesMoved += 1;
        else if (d.untouchable) stagesSkippedUntouchable += 1;
        else if (d.unknown) stagesSkippedUnknown += 1;
        if (samples.length < 20) {
          samples.push({
            dry_run: true,
            dealId,
            cpf,
            rgm,
            from: stageNameFromId(currentStageId) || currentStageId,
            to: classification.stageName,
            move: d.move,
            untouchable: d.untouchable,
            unknown_stage: d.unknown,
            in_caa_fresh: inCaaFresh,
            in_caa_open: inCaaOpen,
            flags: classification.flags,
            flags_would_write: flagValues.length,
            situacao_sem_remat_would_write: semRematSituacaoValues.length > 0,
          });
        }
        continue;
      }

      const cacheDecide = decideMove(currentStageId, inCaaOpen);
      const needsFlagWrite = flagValues.length > 0;
      const needsFieldWrite = fieldValues.length > 0;
      const needsSemRematSituacao = semRematSituacaoValues.length > 0;
      const needsMove = Boolean(cacheDecide.move && classification.stageId);
      // Etapa desconhecida no cache: só getDeal se LIVE_STAGE=1; senão skip move.
      if (cacheDecide.unknown) {
        if (liveStage && doFlags && classification.stageId) {
          workQueue.push({
            dealId,
            cpf,
            rgm,
            inCaaOpen,
            inCaaFresh,
            classification,
            values,
            needsFlagWrite,
            needsFieldWrite,
            needsSemRematSituacao,
            needsMove: true,
            needsLiveStage: true,
            fromStageId: currentStageId,
          });
        } else {
          stagesSkippedUnknown += 1;
          if (!needsFlagWrite && !needsFieldWrite && !needsSemRematSituacao) skippedUnchanged += 1;
          else {
            workQueue.push({
              dealId,
              cpf,
              rgm,
              inCaaOpen,
              inCaaFresh,
              classification,
              values,
              needsFlagWrite,
              needsFieldWrite,
              needsSemRematSituacao,
              needsMove: false,
              needsLiveStage: false,
              fromStageId: currentStageId,
            });
          }
        }
        continue;
      }

      if (!needsFlagWrite && !needsFieldWrite && !needsSemRematSituacao && !needsMove) {
        skippedUnchanged += 1;
        if (cacheDecide.untouchable) stagesSkippedUntouchable += 1;
        continue;
      }

      workQueue.push({
        dealId,
        cpf,
        rgm,
        inCaaOpen,
        inCaaFresh,
        classification,
        values,
        needsFlagWrite,
        needsFieldWrite,
        needsSemRematSituacao,
        needsMove,
        // Default: confia no cache (1 PUT stage). LIVE_STAGE=1 → getDeal antes.
        needsLiveStage: Boolean(liveStage && needsMove),
        fromStageId: currentStageId,
      });
    }
  }

  // ===== Passo INVERSO (saída): fecha flags/etapa de quem SAIU da base do dia. =====
  // Varre TODOS os deals do cache com flag=Sim / etapa Sem Remat. Quem já foi
  // enfileirado no loop principal (matched) é mesclado por dealId (idempotente).
  if (doFlags && !aborted) {
    patchJob({ phase: 'processing_exit', status_message: 'Verificando saídas (entrada/saída)…' });

    const sanityRatio = flagsExitSanityRatio();
    const exitFlagDefs = [
      {
        key: 'doc_pendentes',
        fieldId: fieldIds.doc_pendentes,
        names: ['doc pendentes', 'doc_pendentes', 'docpendente'],
        index: doc,
      },
      {
        key: 'inadimplente',
        fieldId: fieldIds.inadimplente,
        names: ['inadimplente', 'situacaofinanceira', 'situacao financeira', 'financeiro'],
        index: inad,
      },
      {
        key: 'acessoblack',
        fieldId: fieldIds.acessoblack,
        names: ['acessoblack', 'acesso black'],
        index: bb,
      },
      { key: 'evasao', fieldId: fieldIds.evasao, names: ['evasao', 'evasão'], index: evasao },
    ];

    /** @type {Record<string, number>} */
    const flagSimCount = { doc_pendentes: 0, inadimplente: 0, acessoblack: 0, evasao: 0 };
    /** @type {Array<{dealId:string, fieldId:string, key:string, cpf:string, rgm:string}>} */
    const flagExitCandidates = [];
    let semRematSimCount = 0;
    /** @type {Array<{dealId:string, deal:object, cpf:string, rgm:string, matRow:object, currentStageId:string}>} */
    const semRematExitCandidates = [];

    for (const row of cacheRows) {
      const deals = dealsFromCacheRow(row);
      if (!deals.length) continue;
      const cpfCache = normalizeCpf(row.cpf_norm);
      const emailCache = normalizeEmail(row.email_norm);
      const phoneCache = normalizePhone(row.phone_norm);

      for (const deal of deals) {
        const dealId = String(deal.id || '').trim();
        if (!dealId) continue;

        const rgmDeal = normalizeRgm(findCustom(deal, ['rgm']) || row.rgm_norm);
        const cpfDeal = normalizeCpf(findCustom(deal, ['cpf']) || cpfCache);
        const identity = { cpf: cpfDeal, rgm: rgmDeal, email: emailCache, phone: phoneCache };

        for (const def of exitFlagDefs) {
          if (!def.fieldId) continue;
          const cur = normFlagValue(readDealField(deal, def.fieldId, def.names));
          if (cur !== 'sim') continue;
          flagSimCount[def.key] += 1;
          if (!identityInIndex(def.index, identity)) {
            flagExitCandidates.push({
              dealId,
              fieldId: def.fieldId,
              key: def.key,
              cpf: cpfDeal,
              rgm: rgmDeal,
            });
          }
        }

        const currentStageId = String(deal.stageId || '').trim() || null;
        if (semRematStageId && currentStageId === semRematStageId) {
          semRematSimCount += 1;
          if (!identityInIndex(remat, identity)) {
            const matRow =
              (rgmDeal && byRgm.get(rgmDeal)) ||
              (cpfDeal.length >= 11 && byCpf.get(cpfDeal)) ||
              (emailCache && byEmail.get(emailCache)) ||
              (phoneCache && byPhone.get(phoneCache)) ||
              null;
            // Sem matRow não dá pra reclassificar com segurança — deixa a etapa como está.
            if (matRow) {
              semRematExitCandidates.push({
                dealId,
                deal,
                cpf: cpfDeal,
                rgm: rgmDeal,
                matRow,
                currentStageId,
              });
            }
          }
        }
      }
    }

    /** @type {Record<string, boolean>} */
    const flagsExitAllowed = {};
    for (const def of exitFlagDefs) {
      const base = def.index;
      const simCount = flagSimCount[def.key];
      const allowed = base.nRows > 0 && base.nRows >= sanityRatio * simCount;
      flagsExitAllowed[def.key] = allowed;
      if (!allowed) {
        exitSkippedSanity[def.key] = flagExitCandidates.filter((c) => c.key === def.key).length;
      }
    }
    const semRematExitAllowed = remat.nRows > 0 && remat.nRows >= sanityRatio * semRematSimCount;
    if (!semRematExitAllowed) exitSkippedSanity.sem_rematricula = semRematExitCandidates.length;

    const workQueueByDealId = new Map(workQueue.map((item) => [item.dealId, item]));

    // --- Flags: Sim→Não quando a identidade some da base (sanity permitindo) ---
    for (const def of exitFlagDefs) {
      if (!flagsExitAllowed[def.key]) continue;
      const candidates = flagExitCandidates.filter((c) => c.key === def.key);
      for (const c of candidates) {
        if (dryRun) {
          flagsExitCleared += 1;
          if (samples.length < 20) {
            samples.push({
              dry_run: true,
              exit: true,
              dealId: c.dealId,
              cpf: c.cpf,
              rgm: c.rgm,
              flag: def.key,
              from: 'Sim',
              to: 'Não',
            });
          }
          continue;
        }
        let item = workQueueByDealId.get(c.dealId);
        if (!item) {
          item = {
            dealId: c.dealId,
            cpf: c.cpf,
            rgm: c.rgm,
            inCaaOpen: false,
            inCaaFresh: false,
            classification: null,
            values: [],
            needsFlagWrite: false,
            needsFieldWrite: false,
            needsSemRematSituacao: false,
            needsMove: false,
            needsLiveStage: false,
            fromStageId: null,
          };
          workQueueByDealId.set(c.dealId, item);
          workQueue.push(item);
        }
        if (!item.values.some((v) => v.fieldId === def.fieldId)) {
          item.values.push({ fieldId: def.fieldId, value: 'Não' });
          item.needsFlagWrite = true;
          item.exitFlagCount = (item.exitFlagCount || 0) + 1;
        }
      }
    }

    // --- Sem Rematricula: sai quando some do índice de rematrícula (só com matRow) ---
    if (semRematExitAllowed) {
      for (const c of semRematExitCandidates) {
        const existing = workQueueByDealId.get(c.dealId);
        if (existing?.needsMove) continue; // já tratado pelo loop principal.

        const mapped = extractMatriculadosMappedValues(c.matRow);
        const cpf = digits(mapped.cpf) || c.cpf;
        const rgm = digits(mapped.rgm) || c.rgm;
        const emailForMatch = normalizeEmail(mapped._email) || normalizeEmail(mapped.e_mail_ad);
        const phoneForMatch = normalizePhone(mapped._phone || mapped.telefone_comercial);
        const exitIdentity = {
          cpf: normalizeCpf(cpf),
          rgm: normalizeRgm(rgm),
          email: emailForMatch,
          phone: phoneForMatch,
        };
        const caaT0 = caaProtocolsRepo.lookupCaaT0(caaT0Map, cpf, rgm);
        const inCaaOpen = Boolean(caaT0);
        const inCaaFresh = isCaaWithinRetencaoWindow(caaT0);
        const classification = classifyMatriculado(c.matRow, {
          inRematricula: false,
          inCaaFresh,
          inDoc: identityInIndex(doc, exitIdentity),
          inInad: identityInIndex(inad, exitIdentity),
          inBb: identityInIndex(bb, exitIdentity),
          inEvasao: identityInIndex(evasao, exitIdentity),
        });

        const situacaoValues = [];
        if (fieldIds.situacao) {
          const curSituacao = readDealField(c.deal, fieldIds.situacao, [
            'situação',
            'situacao',
            'situação matrícula',
          ]);
          const novaSituacao = resolveSituacaoCrm(mapped.situacao || c.matRow['Situação Matrícula'], {
            inRematricula: false,
          });
          if (novaSituacao && normalizeSituacaoCrm(curSituacao) !== normalizeSituacaoCrm(novaSituacao)) {
            situacaoValues.push({ fieldId: fieldIds.situacao, value: novaSituacao });
          }
        }

        if (dryRun) {
          stagesExitRemat += 1;
          if (samples.length < 20) {
            samples.push({
              dry_run: true,
              exit: true,
              dealId: c.dealId,
              cpf,
              rgm,
              from: 'Sem Rematricula',
              to: classification.stageName,
              situacao_would_write: situacaoValues.length > 0,
            });
          }
          continue;
        }

        let item = workQueueByDealId.get(c.dealId);
        if (!item) {
          item = {
            dealId: c.dealId,
            cpf,
            rgm,
            inCaaOpen,
            inCaaFresh,
            classification,
            values: [],
            needsFlagWrite: false,
            needsFieldWrite: false,
            needsSemRematSituacao: false,
            needsMove: false,
            needsLiveStage: false,
            fromStageId: c.currentStageId,
          };
          workQueueByDealId.set(c.dealId, item);
          workQueue.push(item);
        } else {
          item.classification = classification;
          item.inCaaOpen = inCaaOpen;
          item.inCaaFresh = inCaaFresh;
          if (!item.fromStageId) item.fromStageId = c.currentStageId;
        }
        if (situacaoValues.length && !item.values.some((v) => v.fieldId === fieldIds.situacao)) {
          item.values.push(...situacaoValues);
          item.needsSemRematSituacao = true;
        }
        item.needsMove = true;
        item.isExitRemat = true;
      }
    }
  }

  if (!dryRun && workQueue.length && !aborted) {
    patchJob({
      phase: 'writing',
      status_message: `Gravando ${workQueue.length} alterações (${concurrency} workers)…`,
      total: workQueue.length,
      processed: 0,
    });
    let cursor = 0;
    let written = 0;
    const decideMoveWork = (stageId, caaOpen, classification) => {
      if (!doFlags || !classification.stageId) {
        return { move: false, untouchable: false, unknown: false };
      }
      if (!stageId) return { move: false, untouchable: false, unknown: true };
      if (isUntouchableStageId(stageId)) {
        return { move: false, untouchable: true, unknown: false };
      }
      if (retencaoStageId && stageId === retencaoStageId && !caaOpen) {
        return { move: false, untouchable: true, unknown: false };
      }
      if (classification.stageId === stageId) {
        return { move: false, untouchable: false, unknown: false };
      }
      return { move: true, untouchable: false, unknown: false };
    };

    const worker = async () => {
      while (!aborted) {
        const idx = cursor++;
        if (idx >= workQueue.length) return;
        const item = workQueue[idx];
        try {
          if (item.values?.length) {
            await updateDealCustomFields(item.dealId, item.values);
            if (item.needsFlagWrite) flagsUpdated += 1;
            if (item.needsFieldWrite) fieldsUpdated += 1;
            if (item.needsSemRematSituacao) situacaoSemRematUpdated += 1;
            if (item.exitFlagCount) flagsExitCleared += item.exitFlagCount;
          }

          let stageId = item.fromStageId;
          if (item.needsLiveStage) {
            try {
              const live = await getDeal(item.dealId);
              stageId = String(live?.stageId || live?.stage?.id || '').trim() || null;
            } catch (err) {
              if (isDealMissingError(err)) {
                noteMissing(item.dealId, item.cpf);
                written += 1;
                continue;
              }
              noteError({ dealId: item.dealId, cpf: item.cpf, error: `getDeal: ${err?.message || err}` });
              stagesSkippedUnknown += 1;
              written += 1;
              continue;
            }
          }

          if (item.needsMove || item.needsLiveStage) {
            const d = decideMoveWork(stageId, item.inCaaOpen, item.classification);
            if (d.move) {
              await updateDeal(item.dealId, { stageId: item.classification.stageId });
              stagesMoved += 1;
              if (item.isExitRemat) stagesExitRemat += 1;
            } else if (d.untouchable) {
              stagesSkippedUntouchable += 1;
            } else if (d.unknown) {
              stagesSkippedUnknown += 1;
            }
            if (samples.length < 15) {
              samples.push({
                dealId: item.dealId,
                cpf: item.cpf,
                rgm: item.rgm,
                from: stageNameFromId(stageId) || stageId,
                to: item.classification.stageName,
                moved: d.move,
                untouchable: d.untouchable,
                unknown_stage: d.unknown,
                in_caa_fresh: item.inCaaFresh,
                in_caa_open: item.inCaaOpen,
              });
            }
          }
        } catch (err) {
          if (isDealMissingError(err)) {
            noteMissing(item.dealId, item.cpf);
          } else {
            noteError({ dealId: item.dealId, cpf: item.cpf, error: err?.message || String(err) });
            console.warn(`[novo-crm-flags-sync] FAIL deal=${item.dealId}:`, err?.message || err);
          }
        }
        written += 1;
        if (written % 50 === 0 || written === workQueue.length) {
          patchJob({
            processed: written,
            sent: flagsUpdated + stagesMoved + fieldsUpdated,
            status_message: `Gravados ${written}/${workQueue.length}…`,
          });
        }
      }
    };

    console.log(
      `[novo-crm-flags-sync] write queue=${workQueue.length} concurrency=${concurrency} live_stage=${liveStage}`
    );
    await Promise.all(Array.from({ length: concurrency }, () => worker()));
  }

  const result = {
    ok: !aborted,
    dry_run: dryRun,
    mode,
    scanned,
    matched,
    flags_updated: flagsUpdated,
    flags_exit_cleared: flagsExitCleared,
    fields_updated: fieldsUpdated,
    situacao_sem_remat_updated: dryRun ? situacaoSemRematWouldUpdate : situacaoSemRematUpdated,
    situacao_sem_remat_would_update: situacaoSemRematWouldUpdate,
    stages_moved: stagesMoved,
    stages_exit_remat: stagesExitRemat,
    stages_skipped_untouchable: stagesSkippedUntouchable,
    stages_skipped_unknown: stagesSkippedUnknown,
    exit_skipped_sanity: exitSkippedSanity,
    skipped_no_match: skippedNoMatch,
    skipped_no_deal: skippedNoDeal,
    skipped_missing: skippedMissing,
    skipped_unchanged: skippedUnchanged,
    write_queue: dryRun ? 0 : workQueue.length,
    concurrency,
    live_stage: liveStage,
    caa_retencao_hours: caaRetencaoHours,
    caa_open_ids: caaT0Map.size,
    stages_by_target: stagesByTarget,
    errors,
    aborted,
    abort_reason: abortReason,
    error_budget: errorBudget,
    samples,
    error_samples: errorSamples,
    matriculados_snapshot_id: matSnap.id,
  };

  patchJob({
    phase: 'done',
    status: aborted ? 'failed' : 'completed',
    finished_at: new Date().toISOString(),
    result,
    processed: scanned,
    sent: flagsUpdated + stagesMoved + fieldsUpdated,
    status_message: aborted
      ? abortReason
      : dryRun
        ? 'Prévia pronta'
        : 'Sync concluído',
  });

  // Persiste última Att (apply real) — jobs em memória somem no restart.
  if (!dryRun) {
    try {
      await cacheRepo.saveFlagsStageLastRun({
        finished_at: new Date().toISOString(),
        ok: !aborted,
        mode,
        dry_run: false,
        scanned,
        matched,
        flags_updated: flagsUpdated,
        flags_exit_cleared: flagsExitCleared,
        fields_updated: fieldsUpdated,
        stages_moved: stagesMoved,
        stages_exit_remat: stagesExitRemat,
        stages_skipped_untouchable: stagesSkippedUntouchable,
        exit_skipped_sanity: exitSkippedSanity,
        skipped_unchanged: skippedUnchanged,
        errors,
        aborted,
        abort_reason: abortReason || null,
        matriculados_snapshot_id: matSnap.id,
      });
    } catch (err) {
      console.warn('[novo-crm-flags-sync] save last run failed:', err?.message || err);
    }
  }

  console.log('[novo-crm-flags-sync] done', JSON.stringify({ ...result, samples: undefined }));
  return result;
}

/** @type {Map<string, object>} */
const jobs = new Map();
let runningJobId = null;
/** Promise ativa — cobre sync HTTP e background. */
let activeFlagsPromise = null;

export function isFlagsStageSyncRunning() {
  return activeFlagsPromise != null || (runningJobId != null && jobs.get(runningJobId)?.status === 'running');
}

export function getFlagsStageSyncJob(jobId) {
  return jobs.get(String(jobId || '')) || null;
}

export function getRunningFlagsStageSyncJob() {
  if (!runningJobId) return null;
  const j = jobs.get(runningJobId);
  return j?.status === 'running' ? j : null;
}

/**
 * Mutex: impede sync HTTP + background + cron em paralelo.
 * @param {{ dryRun?: boolean, mode?: string, maxDeals?: number, jobId?: string|null }} opts
 */
export async function runFlagsStageSyncLocked(opts = {}) {
  if (activeFlagsPromise) {
    const err = new Error('Sync de flags/etapa já em andamento');
    err.status = 409;
    throw err;
  }
  activeFlagsPromise = runFlagsStageSync(opts);
  try {
    return await activeFlagsPromise;
  } finally {
    activeFlagsPromise = null;
  }
}

/**
 * @param {{ mode?: string, dryRun?: boolean, maxDeals?: number }} opts
 */
export function startFlagsStageSyncBackground(opts = {}) {
  if (isFlagsStageSyncRunning()) {
    return { started: false, jobId: runningJobId, error: 'Sync de flags/etapa já em andamento' };
  }
  const jobId = randomUUID();
  const entry = {
    jobId,
    mode: opts.mode || 'flags_stage',
    status: 'running',
    dry_run: Boolean(opts.dryRun),
    total: 0,
    processed: 0,
    sent: 0,
    phase: 'starting',
    status_message: 'Iniciando…',
    started_at: new Date().toISOString(),
    finished_at: null,
    result: null,
    error: null,
  };
  jobs.set(jobId, entry);
  runningJobId = jobId;

  activeFlagsPromise = runFlagsStageSync({
    dryRun: Boolean(opts.dryRun),
    mode: opts.mode || 'flags_stage',
    maxDeals: opts.maxDeals,
    jobId,
  })
    .then((result) => {
      entry.status = result?.aborted ? 'failed' : 'completed';
      entry.result = result;
      entry.finished_at = new Date().toISOString();
      if (result?.aborted) entry.error = result.abort_reason;
      return result;
    })
    .catch((err) => {
      entry.status = 'failed';
      entry.error = err?.message || String(err);
      entry.finished_at = new Date().toISOString();
      throw err;
    })
    .finally(() => {
      if (runningJobId === jobId) runningJobId = null;
      activeFlagsPromise = null;
    });

  return { started: true, jobId };
}

function fieldsHourUtc() {
  // Default 08:00 UTC = 05:00 BRT (após provision ~04:00 BRT).
  return Math.max(
    0,
    Math.min(23, Math.floor(Number(process.env.NOVO_CRM_FIELDS_SYNC_HOUR_UTC) || 8))
  );
}

function msUntilHourUtc(hourUtc) {
  const now = new Date();
  const next = new Date(now);
  next.setUTCHours(hourUtc, 0, 0, 0);
  if (next <= now) next.setUTCDate(next.getUTCDate() + 1);
  return next.getTime() - now.getTime();
}

/** Cron noturno: atualiza só campos SIAA dos deals existentes. */
export function startExistingFieldsSyncCron() {
  if (String(process.env.NOVO_CRM_FIELDS_SYNC_ENABLED || '').trim() !== '1') {
    console.log('[novo-crm-fields-sync] cron off (NOVO_CRM_FIELDS_SYNC_ENABLED≠1)');
    return;
  }
  if (!isNovoCrmApiConfigured()) {
    console.log('[novo-crm-fields-sync] cron off — API não configurada');
    return;
  }
  if (!isNovoCrmWriteAllowedOnThisHost()) {
    console.log(
      '[novo-crm-fields-sync] cron off — escrita bloqueada neste host (DEV allowlist ou NOVO_CRM_PROVISION_ALLOW_PROD=1 + URL)'
    );
    return;
  }

  const hour = fieldsHourUtc();
  const delay = msUntilHourUtc(hour);
  console.log(
    `[novo-crm-fields-sync] cron: próximo em ${Math.round(delay / 60000)} min (${String(hour).padStart(2, '0')}:00 UTC)`
  );

  const first = setTimeout(() => {
    startFlagsStageSyncBackground({ dryRun: false, mode: 'fields' });
    const daily = setInterval(() => {
      startFlagsStageSyncBackground({ dryRun: false, mode: 'fields' });
    }, 24 * 60 * 60 * 1000);
    if (typeof daily?.unref === 'function') daily.unref();
  }, delay);
  if (typeof first?.unref === 'function') first.unref();
}

function flagsHourUtc() {
  // Default 09:00 UTC = 06:00 BRT (após fields). Manter FLAGS_SYNC_ENABLED=0 em PROD.
  return Math.max(
    0,
    Math.min(23, Math.floor(Number(process.env.NOVO_CRM_FLAGS_SYNC_HOUR_UTC) || 9))
  );
}

/** Cron noturno: flags Sim/Não + move etapa (respeita intocáveis). */
export function startFlagsStageSyncCron() {
  if (String(process.env.NOVO_CRM_FLAGS_SYNC_ENABLED || '').trim() !== '1') {
    console.log('[novo-crm-flags-sync] cron off (NOVO_CRM_FLAGS_SYNC_ENABLED≠1)');
    return;
  }
  if (!isNovoCrmApiConfigured()) {
    console.log('[novo-crm-flags-sync] cron off — API não configurada');
    return;
  }
  if (!isNovoCrmWriteAllowedOnThisHost()) {
    console.log(
      '[novo-crm-flags-sync] cron off — escrita bloqueada neste host (DEV allowlist ou NOVO_CRM_PROVISION_ALLOW_PROD=1 + URL)'
    );
    return;
  }

  const hour = flagsHourUtc();
  const delay = msUntilHourUtc(hour);
  console.log(
    `[novo-crm-flags-sync] cron: próximo em ${Math.round(delay / 60000)} min (${String(hour).padStart(2, '0')}:00 UTC)`
  );

  const first = setTimeout(() => {
    startFlagsStageSyncBackground({ dryRun: false, mode: 'flags_stage' });
    const daily = setInterval(() => {
      startFlagsStageSyncBackground({ dryRun: false, mode: 'flags_stage' });
    }, 24 * 60 * 60 * 1000);
    if (typeof daily?.unref === 'function') daily.unref();
  }, delay);
  if (typeof first?.unref === 'function') first.unref();
}
