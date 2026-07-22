/**
 * Sync diário/manual de matriculados → deals já existentes no Novo CRM.
 *
 * Modes:
 *   flags_stage — atualiza as 4 flags (Sim/Não) + move etapa (respeitando intocáveis)
 *   fields      — sobrescreve campos SIAA (curso/polo/situação/email/rgm/cpf/nasc)
 *   both        — fields + flags_stage
 *
 * Intocáveis (não move etapa): Ganho, Retenção, Cancelado.
 * Fonte: espelho local (novo_crm_person_cache) + snapshots das bases.
 */

import { randomUUID } from 'node:crypto';
import * as baseUploadRepo from '../repositories/baseUploadRepository.js';
import * as cacheRepo from '../repositories/novoCrmPersonCacheRepository.js';
import { extractMatriculadosMappedValues } from '../utils/novoCrmFieldMapping.js';
import {
  classifyMatriculado,
  getNovoCrmDealFieldIds,
  isUntouchableStageId,
  stageNameFromId,
  titleCasePolo,
} from '../utils/novoCrmStageRules.js';
import {
  isNovoCrmApiConfigured,
  updateDeal,
  updateDealCustomFields,
} from './novoCrmClient.js';
import { isProvisionAllowedOnThisHost } from './novoCrmMatriculadosProvisionService.js';

function digits(v) {
  return String(v ?? '').replace(/\D/g, '');
}

function simNao(v) {
  return v ? 'Sim' : 'Não';
}

function inSet(set, cpf, rgm) {
  if (cpf && set.has(`cpf:${cpf}`)) return true;
  if (rgm && set.has(`rgm:${rgm}`)) return true;
  return false;
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

  if (!isNovoCrmApiConfigured()) {
    const err = new Error('NOVO_CRM_ENABLED/TOKEN não configurados');
    err.status = 503;
    throw err;
  }
  if (!isProvisionAllowedOnThisHost()) {
    const err = new Error('Sync de flags/etapa só no CRM DEV (ou ALLOW_PROD=1)');
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

  const [remat, doc, inad, bb, evasao] = await Promise.all([
    loadIdSetFromBase('rematricula'),
    loadIdSetFromBase('docs-pendentes'),
    loadIdSetFromBase('inadimplentes-vencidos'),
    loadIdSetFromBase('acessos-blackboard'),
    loadIdSetFromBase('provavel-evasao'),
  ]);

  /** @type {Map<string, Record<string, unknown>>} */
  const byCpf = new Map();
  /** @type {Map<string, Record<string, unknown>>} */
  const byRgm = new Map();
  await baseUploadRepo.forEachRowDataForSnapshot('matriculados', matSnap.id, (row) => {
    const m = extractMatriculadosMappedValues(row);
    const cpf = digits(m.cpf);
    const rgm = digits(m.rgm);
    if (cpf.length >= 11 && !byCpf.has(cpf)) byCpf.set(cpf, row);
    if (rgm && !byRgm.has(rgm)) byRgm.set(rgm, row);
  });

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
  let fieldsUpdated = 0;
  let skippedNoMatch = 0;
  let skippedNoDeal = 0;
  let errors = 0;
  /** @type {Array<object>} */
  const samples = [];
  /** @type {Array<object>} */
  const errorSamples = [];

  patchJob({
    phase: 'processing',
    status_message: 'Processando deals…',
    total: cacheRows.length,
  });

  outer: for (const row of cacheRows) {
    const deals = dealsFromCacheRow(row);
    if (!deals.length) {
      skippedNoDeal += 1;
      continue;
    }

    const cpfCache = digits(row.cpf_norm);

    for (const deal of deals) {
      if (scanned >= maxDeals) break outer;
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
      const matRow = (rgmDeal && byRgm.get(rgmDeal)) || (cpfDeal.length >= 11 && byCpf.get(cpfDeal)) || null;
      if (!matRow) {
        skippedNoMatch += 1;
        continue;
      }
      matched += 1;

      const mapped = extractMatriculadosMappedValues(matRow);
      const cpf = digits(mapped.cpf) || cpfDeal;
      const rgm = digits(mapped.rgm) || rgmDeal;
      const classification = classifyMatriculado(matRow, {
        inRematricula: inSet(remat, cpf, rgm),
        inDoc: inSet(doc, cpf, rgm),
        inInad: inSet(inad, cpf, rgm),
        inBb: inSet(bb, cpf, rgm),
        inEvasao: inSet(evasao, cpf, rgm),
      });

      const currentStageId = String(deal.stageId || '').trim() || null;
      const untouchable = isUntouchableStageId(currentStageId);
      const stageNeedsMove =
        doFlags &&
        classification.stageId &&
        classification.stageId !== currentStageId &&
        !untouchable;

      /** @type {Array<{fieldId:string,value:string}>} */
      const values = [];
      if (doFlags) {
        values.push(
          { fieldId: fieldIds.doc_pendentes, value: simNao(classification.flags.doc_pendentes) },
          { fieldId: fieldIds.inadimplente, value: simNao(classification.flags.inadimplente) },
          { fieldId: fieldIds.acessoblack, value: simNao(classification.flags.acessoblack) },
          { fieldId: fieldIds.evasao, value: simNao(classification.flags.evasao) }
        );
      }
      if (doFields) {
        if (digits(mapped.cpf)) values.push({ fieldId: fieldIds.cpf, value: digits(mapped.cpf) });
        if (digits(mapped.rgm)) values.push({ fieldId: fieldIds.rgm, value: digits(mapped.rgm) });
        if (mapped.curso) values.push({ fieldId: fieldIds.curso, value: mapped.curso });
        if (mapped.polo) {
          values.push({
            fieldId: fieldIds.polo,
            value: titleCasePolo(mapped.polo) || mapped.polo,
          });
        }
        const situacao = mapped.situacao || String(matRow['Situação Matrícula'] || '');
        if (situacao) values.push({ fieldId: fieldIds.situacao, value: situacao });
        if (mapped._email) values.push({ fieldId: fieldIds.email, value: mapped._email });
        if (mapped.e_mail_ad) values.push({ fieldId: fieldIds.email_ad, value: mapped.e_mail_ad });
        if (matRow['Data Nascimento']) {
          values.push({
            fieldId: fieldIds.nasc,
            value: String(matRow['Data Nascimento']).slice(0, 10),
          });
        }
      }

      if (dryRun) {
        if (doFlags) flagsUpdated += 1;
        if (doFields) fieldsUpdated += 1;
        if (stageNeedsMove) stagesMoved += 1;
        else if (doFlags && untouchable && classification.stageId !== currentStageId) {
          stagesSkippedUntouchable += 1;
        }
        if (samples.length < 20) {
          samples.push({
            dry_run: true,
            dealId,
            cpf,
            rgm,
            from: stageNameFromId(currentStageId) || currentStageId,
            to: classification.stageName,
            move: Boolean(stageNeedsMove),
            untouchable,
            flags: classification.flags,
          });
        }
        continue;
      }

      try {
        if (values.length) {
          await updateDealCustomFields(dealId, values);
          if (doFlags) flagsUpdated += 1;
          if (doFields) fieldsUpdated += 1;
        }
        if (stageNeedsMove) {
          await updateDeal(dealId, { stageId: classification.stageId });
          stagesMoved += 1;
        } else if (doFlags && untouchable && classification.stageId !== currentStageId) {
          stagesSkippedUntouchable += 1;
        }
        if (samples.length < 15) {
          samples.push({
            dealId,
            cpf,
            rgm,
            from: stageNameFromId(currentStageId) || currentStageId,
            to: classification.stageName,
            moved: Boolean(stageNeedsMove),
            untouchable,
          });
        }
      } catch (err) {
        errors += 1;
        if (errorSamples.length < 15) {
          errorSamples.push({ dealId, cpf, error: err?.message || String(err) });
        }
        console.warn(`[novo-crm-flags-sync] FAIL deal=${dealId}:`, err?.message || err);
      }
    }
  }

  const result = {
    ok: true,
    dry_run: dryRun,
    mode,
    scanned,
    matched,
    flags_updated: flagsUpdated,
    fields_updated: fieldsUpdated,
    stages_moved: stagesMoved,
    stages_skipped_untouchable: stagesSkippedUntouchable,
    skipped_no_match: skippedNoMatch,
    skipped_no_deal: skippedNoDeal,
    errors,
    samples,
    error_samples: errorSamples,
    matriculados_snapshot_id: matSnap.id,
  };

  patchJob({
    phase: 'done',
    status: 'completed',
    finished_at: new Date().toISOString(),
    result,
    processed: scanned,
    sent: flagsUpdated + stagesMoved + fieldsUpdated,
    status_message: dryRun ? 'Prévia pronta' : 'Sync concluído',
  });

  console.log('[novo-crm-flags-sync] done', JSON.stringify({ ...result, samples: undefined }));
  return result;
}

/** @type {Map<string, object>} */
const jobs = new Map();
let runningJobId = null;

export function isFlagsStageSyncRunning() {
  return runningJobId != null && jobs.get(runningJobId)?.status === 'running';
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

  void runFlagsStageSync({
    dryRun: Boolean(opts.dryRun),
    mode: opts.mode || 'flags_stage',
    maxDeals: opts.maxDeals,
    jobId,
  })
    .then((result) => {
      entry.status = 'completed';
      entry.result = result;
      entry.finished_at = new Date().toISOString();
    })
    .catch((err) => {
      entry.status = 'failed';
      entry.error = err?.message || String(err);
      entry.finished_at = new Date().toISOString();
    })
    .finally(() => {
      if (runningJobId === jobId) runningJobId = null;
    });

  return { started: true, jobId };
}

function fieldsHourUtc() {
  // Default: 1h depois do provision (05:00 UTC = 02:00 BRT).
  return Math.max(
    0,
    Math.min(23, Math.floor(Number(process.env.NOVO_CRM_FIELDS_SYNC_HOUR_UTC) || 5))
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
  if (!isProvisionAllowedOnThisHost()) {
    console.log('[novo-crm-fields-sync] cron off — host não é DEV');
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
