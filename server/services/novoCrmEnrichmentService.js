/**
 * Enriquecimento empty-only: cache Novo CRM ← snapshot matriculados.
 * preview (dry_run) e apply (grava via API HTTP).
 */

import { randomUUID } from 'node:crypto';
import * as baseUploadRepo from '../repositories/baseUploadRepository.js';
import * as cacheRepo from '../repositories/novoCrmPersonCacheRepository.js';
import {
  dealCustomFieldMapFromRaw,
  extractMatriculadosMappedValues,
  fieldNamesForScope,
} from '../utils/novoCrmFieldMapping.js';
import {
  normalizeCpf,
  normalizeEmail,
  normalizePhone,
  normalizeRgm,
} from '../utils/novoCrmCacheNormalize.js';
import {
  getDealCustomFieldsByName,
  isNovoCrmApiConfigured,
  updateContact,
  updateDealCustomFields,
} from './novoCrmClient.js';
import { displayRgmFromMatriculadosRow } from '../utils/rgmDisplay.js';
import { cpfDigitsFromExcelCell } from '../utils/excelNumericCell.js';

const WRITE_DELAY_MS = Math.max(
  50,
  Number(process.env.NOVO_CRM_ENRICH_DELAY_MS || 120) || 120
);

/** @type {Map<string, object>} */
const jobs = new Map();
let runningJobId = null;

const SCOPES = new Set(['cpf', 'rgm', 'incomplete', 'all_mapped']);

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * @param {string} scope
 */
function assertScope(scope) {
  const s = String(scope || '').trim();
  if (!SCOPES.has(s)) {
    const err = new Error(`scope inválido: ${scope}. Use cpf|rgm|incomplete|all_mapped`);
    err.status = 400;
    throw err;
  }
  return s;
}

/**
 * Índice matriculados por cpf / rgm / phone.
 * @param {string} snapshotId
 */
async function buildMatriculadosIndex(snapshotId) {
  /** @type {{ byCpf: Map<string, object>, byRgm: Map<string, object>, byPhone: Map<string, object> }} */
  const index = {
    byCpf: new Map(),
    byRgm: new Map(),
    byPhone: new Map(),
  };

  await baseUploadRepo.forEachRowDataForSnapshot('matriculados', snapshotId, (row) => {
    const mapped = extractMatriculadosMappedValues(row);
    const cpf = normalizeCpf(cpfDigitsFromExcelCell(mapped.cpf || row.CPF || ''));
    const rgmDisp = displayRgmFromMatriculadosRow(row);
    const rgm = normalizeRgm(rgmDisp || mapped.rgm);
    const phone = normalizePhone(mapped._phone || mapped.telefone_comercial);

    const payload = { row, mapped, cpf, rgm, phone };

    if (cpf && !index.byCpf.has(cpf)) index.byCpf.set(cpf, payload);
    if (rgm && !index.byRgm.has(rgm)) index.byRgm.set(rgm, payload);
    if (phone && !index.byPhone.has(phone)) index.byPhone.set(phone, payload);
  });

  return index;
}

/**
 * @param {object} cacheRow
 * @param {{ byCpf: Map, byRgm: Map, byPhone: Map }} index
 */
function matchMatriculado(cacheRow, index) {
  const cpf = normalizeCpf(cacheRow.cpf_norm);
  if (cpf && index.byCpf.has(cpf)) return index.byCpf.get(cpf);

  const rgm = normalizeRgm(cacheRow.rgm_norm);
  if (rgm && index.byRgm.has(rgm)) return index.byRgm.get(rgm);

  const phone = normalizePhone(cacheRow.phone_norm);
  if (phone && index.byPhone.has(phone)) return index.byPhone.get(phone);

  // tenta CPF/RGM já no raw deal (mesmo que denorm vazio — raro)
  const fields = dealCustomFieldMapFromRaw(cacheRow.raw_data);
  const cpf2 = normalizeCpf(fields.cpf);
  if (cpf2 && index.byCpf.has(cpf2)) return index.byCpf.get(cpf2);
  const rgm2 = normalizeRgm(fields.rgm);
  if (rgm2 && index.byRgm.has(rgm2)) return index.byRgm.get(rgm2);

  return null;
}

/**
 * Calcula fills empty-only para um cache row.
 * @returns {{ dealValues: Array<{name:string,fieldId:string|null,value:string}>, contactPatch: object, fillNames: string[] }|null}
 */
function computeFills(cacheRow, matched, scope, fieldDefs) {
  const wanted = fieldNamesForScope(scope);
  const current = dealCustomFieldMapFromRaw(cacheRow.raw_data);
  const mapped = matched.mapped;

  /** @type {Array<{name:string,fieldId:string|null,value:string}>} */
  const dealValues = [];
  const fillNames = [];

  for (const name of wanted) {
    const cur = current[name];
    if (cur != null && String(cur).trim() !== '') continue;
    if (name === 'cpf' && cacheRow.cpf_norm) continue;
    if (name === 'rgm' && cacheRow.rgm_norm) continue;

    let next = mapped[name];
    if (next == null || String(next).trim() === '') continue;
    next = String(next).trim();

    if (name === 'cpf') {
      next = normalizeCpf(next);
      if (!next) continue;
    }
    if (name === 'rgm') {
      next = normalizeRgm(next);
      if (!next) continue;
    }
    if (name === 'e_mail_ad') {
      next = normalizeEmail(next) || next;
    }
    if (name === 'telefone_comercial') {
      const p = normalizePhone(next);
      if (!p) continue;
      next = p;
    }

    const def = fieldDefs.get(name);
    dealValues.push({ name, fieldId: def?.id ? String(def.id) : null, value: next });
    fillNames.push(name);
  }

  /** @type {Record<string, string>} */
  const contactPatch = {};
  if (!cacheRow.nome && mapped._nome_full) contactPatch.name = mapped._nome_full;
  if (!cacheRow.phone_norm && mapped._phone) {
    const p = normalizePhone(mapped._phone);
    if (p) contactPatch.phone = p.length === 11 || p.length === 10 ? `55${p}` : p;
  }
  if (!cacheRow.email_norm && mapped._email) {
    const e = normalizeEmail(mapped._email);
    if (e) contactPatch.email = e;
  }

  if (!dealValues.length && !Object.keys(contactPatch).length) return null;
  return { dealValues, contactPatch, fillNames };
}

/**
 * @param {{ scope: string, dryRun?: boolean, limit?: number, jobId?: string|null }} opts
 */
async function runEnrichment(opts) {
  const scope = assertScope(opts.scope);
  const dryRun = opts.dryRun !== false;
  const jobId = opts.jobId || null;

  if (!dryRun && !isNovoCrmApiConfigured()) {
    const err = new Error('NOVO_CRM_API_TOKEN / NOVO_CRM_ENABLED não configurados para gravar.');
    err.status = 503;
    throw err;
  }

  const snap = await baseUploadRepo.getLatestSnapshot('matriculados');
  if (!snap?.id) {
    const err = new Error('Nenhum snapshot de matriculados encontrado. Faça upload em Bases.');
    err.status = 400;
    throw err;
  }

  const patchJob = (p) => {
    if (!jobId) return;
    const entry = jobs.get(jobId);
    if (!entry) return;
    Object.assign(entry, p);
  };

  patchJob({ phase: 'index_matriculados', status_message: 'Indexando matriculados…' });
  const index = await buildMatriculadosIndex(snap.id);

  patchJob({ phase: 'load_cache', status_message: 'Carregando cache…' });
  const candidates = await cacheRepo.listActiveCacheRowsForEnrichment({ scope });

  const fieldDefs = dryRun
    ? await getDealCustomFieldsByName().catch(() => new Map())
    : await getDealCustomFieldsByName();

  /** @type {Record<string, number>} */
  const would_fill_by_field = {};
  for (const n of fieldNamesForScope(scope)) would_fill_by_field[n] = 0;

  let matched = 0;
  let no_match = 0;
  let would_update = 0;
  let skipped_no_fill = 0;
  let updated = 0;
  let errors = 0;
  /** @type {Array<{contact_id:string,error:string}>} */
  const errorSamples = [];
  /** @type {Array<object>} */
  const sample = [];

  patchJob({
    phase: 'process',
    total: candidates.length,
    processed: 0,
    status_message: dryRun ? 'Calculando prévia…' : 'Gravando no CRM…',
  });

  for (let i = 0; i < candidates.length; i += 1) {
    const row = candidates[i];
    const hit = matchMatriculado(row, index);
    if (!hit) {
      no_match += 1;
      patchJob({ processed: i + 1 });
      continue;
    }
    matched += 1;

    const fills = computeFills(row, hit, scope, fieldDefs);
    if (!fills) {
      skipped_no_fill += 1;
      patchJob({ processed: i + 1 });
      continue;
    }

    would_update += 1;
    for (const name of fills.fillNames) {
      would_fill_by_field[name] = (would_fill_by_field[name] || 0) + 1;
    }

    if (sample.length < 15) {
      sample.push({
        contact_id: row.contact_id,
        deal_id: row.primary_deal_id,
        nome: row.nome,
        fields: fills.fillNames,
        contact_patch: Object.keys(fills.contactPatch),
      });
    }

    if (!dryRun) {
      try {
        const withIds = fills.dealValues.filter((v) => v.fieldId);
        if (row.primary_deal_id && withIds.length) {
          await updateDealCustomFields(
            row.primary_deal_id,
            withIds.map((v) => ({ fieldId: v.fieldId, value: v.value }))
          );
        } else if (fills.dealValues.length && !withIds.length) {
          throw new Error('Custom field ids não resolvidos — confira NOVO_CRM_API_TOKEN');
        }
        if (Object.keys(fills.contactPatch).length) {
          await updateContact(row.contact_id, fills.contactPatch);
        }
        updated += 1;
        if (WRITE_DELAY_MS > 0) await sleep(WRITE_DELAY_MS);
      } catch (err) {
        errors += 1;
        if (errorSamples.length < 20) {
          errorSamples.push({
            contact_id: row.contact_id,
            error: err?.message || String(err),
          });
        }
      }
    }

    patchJob({
      processed: i + 1,
      sent: dryRun ? would_update : updated,
      failed: errors,
      skipped: skipped_no_fill + no_match,
    });
  }

  const result = {
    ok: true,
    dry_run: dryRun,
    scope,
    matriculados_snapshot_id: snap.id,
    matriculados_file: snap.file_name || null,
    matriculados_rows: snap.row_count ?? null,
    index: {
      by_cpf: index.byCpf.size,
      by_rgm: index.byRgm.size,
      by_phone: index.byPhone.size,
    },
    candidates: candidates.length,
    matched,
    no_match,
    would_update,
    skipped_no_fill,
    updated: dryRun ? 0 : updated,
    errors: dryRun ? 0 : errors,
    would_fill_by_field,
    sample,
    error_samples: errorSamples,
  };

  patchJob({
    phase: 'done',
    status: 'completed',
    finished_at: new Date().toISOString(),
    result,
    status_message: dryRun ? 'Prévia pronta' : 'Enriquecimento concluído',
  });

  return result;
}

/**
 * Prévia síncrona (dry-run).
 * @param {{ scope: string }} opts
 */
export async function previewEnrichment(opts) {
  return runEnrichment({ scope: opts.scope, dryRun: true });
}

/**
 * Apply em background. Retorna jobId.
 * @param {{ scope: string }} opts
 */
export function startEnrichmentApplyBackground(opts) {
  const scope = assertScope(opts.scope);
  if (runningJobId && jobs.get(runningJobId)?.status === 'running') {
    return { started: false, jobId: runningJobId, error: 'Enriquecimento já em andamento' };
  }
  const jobId = randomUUID();
  const entry = {
    jobId,
    scope,
    status: 'running',
    dry_run: false,
    total: 0,
    processed: 0,
    sent: 0,
    failed: 0,
    skipped: 0,
    phase: 'starting',
    status_message: 'Iniciando…',
    started_at: new Date().toISOString(),
    finished_at: null,
    result: null,
    error: null,
  };
  jobs.set(jobId, entry);
  runningJobId = jobId;

  void runEnrichment({ scope, dryRun: false, jobId })
    .then((result) => {
      entry.status = 'completed';
      entry.result = result;
      entry.finished_at = new Date().toISOString();
      cacheRepo.invalidateIncompleteFieldsCache();
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

export function getEnrichmentJob(jobId) {
  return jobs.get(String(jobId || '')) || null;
}

export function getRunningEnrichmentJob() {
  if (!runningJobId) return null;
  const j = jobs.get(runningJobId);
  return j?.status === 'running' ? j : null;
}
