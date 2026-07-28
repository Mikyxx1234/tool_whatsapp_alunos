/**
 * Provisionamento de "órfãos aluno" no Novo CRM: contacts sem nenhum deal
 * (primary_deal_id nulo) cujo e-mail bate com o snapshot de matriculados.
 *
 * Regra (auditoria 28/07/2026, ver AGENTS.md):
 *   - Sem sibling (nenhum outro contact com deal compartilhando email/cpf/rgm)
 *     → cria 1 deal por RGM distinto NO PRÓPRIO contact órfão.
 *   - Com sibling que já tem deal para TODOS os RGMs do aluno
 *     → `dup_contact_skip` (não cria nada; órfão é duplicata de contact).
 *   - Com sibling faltando algum RGM (multi-curso)
 *     → cria os deals que faltam NO SIBLING (contact "bom"), nunca no órfão.
 *   - Nunca cria um segundo contact.
 *
 * Env:
 *   NOVO_CRM_ORPHAN_PROVISION_DELAY_MS=20
 *   NOVO_CRM_ORPHAN_PROVISION_CONCURRENCY=3
 *   NOVO_CRM_ORPHAN_PROVISION_MAX_PER_RUN=20000
 *   NOVO_CRM_ORPHAN_OFFSET=0          — pula N primeiros órfãos (retomada segura)
 *   NOVO_CRM_ORPHAN_LIVE_CHECK=0|1    — default 1; 0 quando offset cobre run anterior
 */

import { randomUUID } from 'node:crypto';
import * as baseUploadRepo from '../repositories/baseUploadRepository.js';
import * as caaProtocolsRepo from '../repositories/caaProtocolsRepository.js';
import * as cacheRepo from '../repositories/novoCrmPersonCacheRepository.js';
import {
  extractMatriculadosMappedValues,
  resolveSituacaoCrm,
} from '../utils/novoCrmFieldMapping.js';
import {
  normalizeCpf,
  normalizeEmail,
  normalizeRgm,
} from '../utils/novoCrmCacheNormalize.js';
import {
  classifyMatriculado,
  getNovoCrmDealFieldIds,
  titleCasePolo,
} from '../utils/novoCrmStageRules.js';
import { displayRgmFromMatriculadosRow } from '../utils/rgmDisplay.js';
import { cpfDigitsFromExcelCell } from '../utils/excelNumericCell.js';
import {
  createDeal,
  findDealForContact,
  getDeal,
  isNovoCrmApiConfigured,
  listDealsPage,
  updateDealCustomFields,
} from './novoCrmClient.js';
import { isNovoCrmWriteAllowedOnThisHost } from './novoCrmMatriculadosProvisionService.js';

/**
 * Guard live leve: 1 GET deals?contactId=. Se já existe deal, pula (órfão
 * deveria ter 0). Desligável via NOVO_CRM_ORPHAN_LIVE_CHECK=0 quando offset
 * cobre a run anterior.
 */
async function liveContactHasAnyDeal(contactId) {
  try {
    const deal = await findDealForContact(contactId);
    return Boolean(deal?.id);
  } catch (err) {
    console.warn('[novo-crm-orphan-provision] live check failed', contactId, err?.message || err);
    return true;
  }
}

function panelFieldValue(dealDetail, names) {
  const wanted = names.map((n) => n.toLowerCase());
  const fields = dealDetail?.dealPanelFields || dealDetail?.customFields || [];
  for (const f of fields) {
    const name = String(f?.name || f?.label || '')
      .trim()
      .toLowerCase();
    if (wanted.includes(name) && f?.value != null && String(f.value).trim() !== '') {
      return String(f.value).trim();
    }
  }
  return '';
}

/**
 * Identidade live no CRM (RGMs + CPFs em TODOS os deals do contact).
 * Usado no path sibling — cache local fica stale entre runs / com SKIP_FIELDS.
 */
async function liveIdentityOnContact(contactId) {
  const rgms = new Set();
  const cpfs = new Set();
  let dealCount = 0;
  try {
    const page = await listDealsPage({ contactId, page: 1, perPage: 100 });
    const items = page.items || [];
    dealCount = items.length;
    for (const d of items) {
      if (!d?.id) continue;
      let detail = d;
      const hasPanel = Array.isArray(d.dealPanelFields) || Array.isArray(d.customFields);
      if (!hasPanel) {
        try {
          detail = (await getDeal(d.id)) || d;
        } catch {
          detail = d;
        }
      }
      const rgm = normalizeRgm(panelFieldValue(detail, ['rgm']));
      const cpf = normalizeCpf(panelFieldValue(detail, ['cpf', 'documento', 'taxid']));
      if (rgm) rgms.add(rgm);
      if (cpf) cpfs.add(cpf);
    }
  } catch (err) {
    console.warn('[novo-crm-orphan-provision] live identity failed', contactId, err?.message || err);
    return { rgms, cpfs, dealCount: -1, ok: false };
  }
  return { rgms, cpfs, dealCount, ok: true };
}

const DELAY_MS = Math.max(
  0,
  Number(process.env.NOVO_CRM_ORPHAN_PROVISION_DELAY_MS ?? 20) || 0
);

function orphanConcurrency() {
  return Math.min(Math.max(Number(process.env.NOVO_CRM_ORPHAN_PROVISION_CONCURRENCY) || 3, 1), 8);
}

function digits(v) {
  return String(v ?? '').replace(/\D/g, '');
}

function simNao(v) {
  return v ? 'Sim' : 'Não';
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function defaultMaxCreates() {
  return Math.min(Math.max(Number(process.env.NOVO_CRM_ORPHAN_PROVISION_MAX_PER_RUN) || 20000, 1), 20000);
}

/**
 * Índice matriculados por e-mail (pessoal ou acadêmico) → deals distintos (por RGM).
 * @param {string} snapshotId
 * @returns {Promise<Map<string, Map<string, { row: object, mapped: object, cpf: string, rgm: string, curso: string }>>>}
 */
async function buildAlunoByEmailIndex(snapshotId) {
  /** @type {Map<string, Map<string, object>>} */
  const byEmail = new Map();

  const addRow = (email, item) => {
    if (!email) return;
    let group = byEmail.get(email);
    if (!group) {
      group = new Map();
      byEmail.set(email, group);
    }
    const key = item.rgm || `_norgm_${group.size}`;
    if (!group.has(key)) group.set(key, item);
  };

  await baseUploadRepo.forEachRowDataForSnapshot('matriculados', snapshotId, (row) => {
    const mapped = extractMatriculadosMappedValues(row);
    const cpf = normalizeCpf(cpfDigitsFromExcelCell(mapped.cpf || row.CPF || ''));
    const rgmDisp = displayRgmFromMatriculadosRow(row);
    const rgm = normalizeRgm(rgmDisp || mapped.rgm);
    const item = { row, mapped, cpf, rgm, curso: mapped.curso };

    const email1 = normalizeEmail(mapped._email);
    const email2 = normalizeEmail(mapped.e_mail_ad);
    addRow(email1, item);
    if (email2 && email2 !== email1) addRow(email2, item);
  });

  return byEmail;
}

/**
 * @param {string} category
 * @returns {Promise<Set<string>>} cpfs + rgms
 */
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

function inSet(set, cpf, rgm) {
  if (cpf && set.has(`cpf:${cpf}`)) return true;
  if (rgm && set.has(`rgm:${rgm}`)) return true;
  return false;
}

function dealsFromCacheRow(row) {
  const raw = row?.raw_data || {};
  const byId = raw.dealsById && typeof raw.dealsById === 'object' ? raw.dealsById : {};
  return Object.values(byId);
}

function dealCustomValue(deal, names) {
  const wanted = names.map((n) => n.toLowerCase());
  for (const f of deal?.customFields || []) {
    const name = String(f?.name || '').trim().toLowerCase();
    if (wanted.includes(name) && f?.value != null && String(f.value).trim() !== '') {
      return String(f.value).trim();
    }
  }
  return '';
}

/** RGMs presentes em qualquer deal do contact (+ denorm rgm_norm). */
function rgmsOnCacheRow(row) {
  const set = new Set();
  if (row.rgm_norm) {
    const g = normalizeRgm(row.rgm_norm);
    if (g) set.add(g);
  }
  for (const deal of dealsFromCacheRow(row)) {
    const g = normalizeRgm(dealCustomValue(deal, ['rgm']));
    if (g) set.add(g);
  }
  return set;
}

function addToMultiMap(map, key, value) {
  if (!key) return;
  let arr = map.get(key);
  if (!arr) {
    arr = [];
    map.set(key, arr);
  }
  if (!arr.includes(value)) arr.push(value);
}

/**
 * Índices do cache completo (contact_id, email, cpf, rgm) — cpf/rgm também
 * varrem TODOS os deals de cada contact (não só o primary).
 */
function buildCacheIndices(cacheRows) {
  const byContactId = new Map();
  const byEmail = new Map();
  const byCpf = new Map();
  const byRgm = new Map();

  for (const row of cacheRows) {
    const id = String(row.contact_id);
    byContactId.set(id, row);

    const email1 = normalizeEmail(row.email_norm);
    const email2 = normalizeEmail(row.raw_data?.contact?.email);
    addToMultiMap(byEmail, email1, id);
    if (email2 && email2 !== email1) addToMultiMap(byEmail, email2, id);

    const cpf1 = normalizeCpf(row.cpf_norm);
    addToMultiMap(byCpf, cpf1, id);

    for (const rgm of rgmsOnCacheRow(row)) addToMultiMap(byRgm, rgm, id);

    for (const deal of dealsFromCacheRow(row)) {
      const cpf2 = normalizeCpf(dealCustomValue(deal, ['cpf', 'documento', 'taxid']));
      if (cpf2) addToMultiMap(byCpf, cpf2, id);
    }
  }

  return { byContactId, byEmail, byCpf, byRgm };
}

/**
 * Acha um contact "sibling" (com pelo menos 1 deal) que compartilhe email/cpf/rgm
 * com o grupo de identidade do aluno, excluindo o próprio contact órfão.
 * @returns {string|null} contact_id do sibling ou null
 */
function findSiblingContactId(orphanContactId, keys, indices) {
  const candidateIds = new Set();
  for (const e of keys.emails) for (const id of indices.byEmail.get(e) || []) candidateIds.add(id);
  for (const c of keys.cpfs) for (const id of indices.byCpf.get(c) || []) candidateIds.add(id);
  for (const r of keys.rgms) for (const id of indices.byRgm.get(r) || []) candidateIds.add(id);
  candidateIds.delete(String(orphanContactId));

  const withDeal = [...candidateIds].filter((id) => {
    const row = indices.byContactId.get(id);
    return row && (row.primary_deal_id || dealsFromCacheRow(row).length > 0);
  });
  if (!withDeal.length) return null;
  withDeal.sort((a, b) => a.localeCompare(b));
  return withDeal[0];
}

/**
 * @param {object} fieldIds
 * @param {object} mapped
 * @param {object} row
 * @param {object} classification
 */
function buildDealValues(fieldIds, mapped, row, classification) {
  return [
    digits(mapped.cpf) ? { fieldId: fieldIds.cpf, value: digits(mapped.cpf) } : null,
    digits(mapped.rgm) ? { fieldId: fieldIds.rgm, value: digits(mapped.rgm) } : null,
    mapped.curso ? { fieldId: fieldIds.curso, value: mapped.curso } : null,
    mapped.polo ? { fieldId: fieldIds.polo, value: titleCasePolo(mapped.polo) || mapped.polo } : null,
    (() => {
      const situacao = resolveSituacaoCrm(mapped.situacao || row['Situação Matrícula'], {
        inRematricula: Boolean(classification.meta?.inRematricula),
      });
      return situacao ? { fieldId: fieldIds.situacao, value: situacao } : null;
    })(),
    mapped.nivel && fieldIds.nivel ? { fieldId: fieldIds.nivel, value: mapped.nivel } : null,
    mapped._email ? { fieldId: fieldIds.email, value: mapped._email } : null,
    mapped.e_mail_ad ? { fieldId: fieldIds.email_ad, value: mapped.e_mail_ad } : null,
    row['Data Nascimento']
      ? { fieldId: fieldIds.nasc, value: String(row['Data Nascimento']).slice(0, 10) }
      : null,
    { fieldId: fieldIds.doc_pendentes, value: simNao(classification.flags.doc_pendentes) },
    { fieldId: fieldIds.inadimplente, value: simNao(classification.flags.inadimplente) },
    { fieldId: fieldIds.acessoblack, value: simNao(classification.flags.acessoblack) },
    { fieldId: fieldIds.evasao, value: simNao(classification.flags.evasao) },
  ].filter(Boolean);
}

/**
 * @param {{ dryRun?: boolean, maxCreates?: number, jobId?: string|null }} [opts]
 */
export async function runOrphanAlunoProvision(opts = {}) {
  const dryRun = opts.dryRun !== false;
  const maxCreates = Math.min(Math.max(Number(opts.maxCreates) || defaultMaxCreates(), 1), 20000);
  const jobId = opts.jobId || null;

  if (!dryRun) {
    if (!isNovoCrmApiConfigured()) {
      const err = new Error('NOVO_CRM_ENABLED/TOKEN não configurados para gravar.');
      err.status = 503;
      throw err;
    }
    if (!isNovoCrmWriteAllowedOnThisHost()) {
      const err = new Error(
        'Provisionamento de órfãos bloqueado neste host. Use CRM DEV ou NOVO_CRM_PROVISION_ALLOW_PROD=1 + URL explícita.'
      );
      err.status = 403;
      throw err;
    }
  }

  const patchJob = (p) => {
    if (!jobId) return;
    const entry = jobs.get(jobId);
    if (!entry) return;
    Object.assign(entry, p);
  };

  patchJob({ phase: 'load_matriculados', status_message: 'Indexando matriculados por e-mail…' });
  const matSnap = await baseUploadRepo.getLatestSnapshot('matriculados');
  if (!matSnap?.id) {
    const err = new Error('Nenhum snapshot de matriculados encontrado. Faça upload em Bases.');
    err.status = 400;
    throw err;
  }
  const byEmail = await buildAlunoByEmailIndex(matSnap.id);

  patchJob({ phase: 'load_bases', status_message: 'Carregando bases satélite…' });
  const [remat, caa, doc, inad, bb, evasao] = await Promise.all([
    loadIdSetFromBase('rematricula'),
    caaProtocolsRepo.loadOpenCaaIdSet(),
    loadIdSetFromBase('docs-pendentes'),
    loadIdSetFromBase('inadimplentes-vencidos'),
    loadIdSetFromBase('acessos-blackboard'),
    loadIdSetFromBase('provavel-evasao'),
  ]);

  patchJob({ phase: 'load_cache', status_message: 'Carregando cache do CRM…' });
  const cacheRows = await cacheRepo.listActiveCacheRowsForEnrichment({ scope: 'all_mapped', limit: 100000 });
  const indices = buildCacheIndices(cacheRows);
  const orphans = cacheRows.filter((r) => !r.primary_deal_id);

  const fieldIds = getNovoCrmDealFieldIds();
  const offset = Math.max(0, Number(opts.offset ?? process.env.NOVO_CRM_ORPHAN_OFFSET) || 0);
  const liveCheckEnv = String(process.env.NOVO_CRM_ORPHAN_LIVE_CHECK ?? '1').trim();
  const liveCheck =
    opts.liveCheck != null ? Boolean(opts.liveCheck) : liveCheckEnv !== '0' && liveCheckEnv !== 'false';
  const concurrency = dryRun ? 1 : orphanConcurrency();

  let scanned = 0;
  let orphanAluno = 0;
  let orphanNoMatch = 0;
  let dupContactSkip = 0;
  let dealsWouldCreateOnOrphan = 0;
  let dealsWouldCreateOnSibling = 0;
  let createdDeals = 0;
  let errors = 0;
  let skippedAlreadyHasDeal = 0;
  let skippedDuplicateRgm = 0;
  let stoppedAtMax = false;
  /** @type {Array<object>} */
  const samples = [];
  /** @type {Array<object>} */
  const errorSamples = [];
  /** @type {Set<string>} claim `${contactId}:${rgm}` na run — evita spam concorrente/reentry */
  const claimedDealKeys = new Set();
  /** @type {Map<string, { rgms: Set<string>, cpfs: Set<string> }>} identidade live memoizada */
  const liveIdentityCache = new Map();

  const skipFieldsAll = String(process.env.NOVO_CRM_ORPHAN_SKIP_FIELDS || '').trim() === '1';

  patchJob({
    phase: 'process',
    total: orphans.length,
    processed: offset,
    status_message: dryRun ? 'Calculando prévia…' : 'Criando deals no CRM…',
  });

  console.log(
    `[novo-crm-orphan-provision] start dry=${dryRun} max=${maxCreates} offset=${offset} conc=${concurrency} delay_ms=${DELAY_MS} liveCheck=${liveCheck} skipFieldsAll=${skipFieldsAll} orphans=${orphans.length}`
  );

  const atMax = () => dealsWouldCreateOnOrphan + dealsWouldCreateOnSibling >= maxCreates;

  function claimKey(contactId, rgm, cpf) {
    const id = String(contactId);
    const keys = [];
    if (rgm) keys.push(`${id}:rgm:${rgm}`);
    else if (cpf) keys.push(`${id}:cpf:${cpf}`);
    else keys.push(`${id}:norgm`);
    for (const k of keys) {
      if (claimedDealKeys.has(k)) return false;
    }
    for (const k of keys) claimedDealKeys.add(k);
    return true;
  }

  function rememberCreatedIdentity(contactId, rgm, cpf) {
    const id = String(contactId);
    addToMultiMap(indices.byRgm, rgm, id);
    addToMultiMap(indices.byCpf, cpf, id);
    let live = liveIdentityCache.get(id);
    if (!live) {
      live = { rgms: new Set(), cpfs: new Set() };
      liveIdentityCache.set(id, live);
    }
    if (rgm) live.rgms.add(rgm);
    if (cpf) live.cpfs.add(cpf);
    const cacheRow = indices.byContactId.get(id);
    if (cacheRow && rgm) {
      // Mantém rgmsOnCacheRow coerente na mesma run (mesmo sem fields no CRM ainda).
      cacheRow.rgm_norm = cacheRow.rgm_norm || rgm;
    }
  }

  async function getMergedSiblingIdentity(siblingId, siblingRow) {
    const id = String(siblingId);
    const fromCache = rgmsOnCacheRow(siblingRow);
    const cpfsCache = new Set();
    const cpf1 = normalizeCpf(siblingRow?.cpf_norm);
    if (cpf1) cpfsCache.add(cpf1);
    for (const deal of dealsFromCacheRow(siblingRow)) {
      const c = normalizeCpf(dealCustomValue(deal, ['cpf', 'documento', 'taxid']));
      if (c) cpfsCache.add(c);
    }

    let live = liveIdentityCache.get(id);
    if (!live) {
      // Sempre consulta API no path sibling (dry ou apply) — cache stale foi a
      // causa raiz do spam de deals (Everton / Flor, 28/07).
      const fetched = await liveIdentityOnContact(id);
      live = { rgms: fetched.rgms, cpfs: fetched.cpfs, dealCount: fetched.dealCount, ok: fetched.ok };
      liveIdentityCache.set(id, live);
    }

    const rgms = new Set([...fromCache, ...live.rgms]);
    const cpfs = new Set([...cpfsCache, ...live.cpfs]);
    const dealCount =
      live.dealCount != null && live.dealCount >= 0
        ? Math.max(live.dealCount, dealsFromCacheRow(siblingRow).length)
        : Math.max(fromCache.size, dealsFromCacheRow(siblingRow).length);
    return { rgms, cpfs, dealCount, liveOk: live.ok !== false };
  }

  async function createOneDeal({ contactId, nome, it, classification }) {
    const rgm = it.rgm || '';
    const cpf = it.cpf || normalizeCpf(digits(it.mapped?.cpf));
    if (!claimKey(contactId, rgm, cpf)) {
      skippedDuplicateRgm += 1;
      return null;
    }
    const deal = await createDeal({ title: nome, contactId, stageId: classification.stageId });
    createdDeals += 1;
    rememberCreatedIdentity(contactId, rgm, cpf);
    try {
      await cacheRepo.markPrimaryDealId(contactId, deal.id);
    } catch {
      /* best-effort */
    }
    // Mesmo com SKIP_FIELDS=1, grava CPF+RGM — sem isso o dedupe sibling
    // não vê o RGM e recria o mesmo deal em runs seguintes (incidente 28/07).
    const values = skipFieldsAll
      ? [
          cpf ? { fieldId: fieldIds.cpf, value: cpf } : null,
          rgm ? { fieldId: fieldIds.rgm, value: rgm } : null,
        ].filter(Boolean)
      : buildDealValues(fieldIds, it.mapped, it.row, classification);
    if (values.length) {
      try {
        await updateDealCustomFields(deal.id, values, { maxRetries: 4 });
      } catch (fieldErr) {
        if (errorSamples.length < 25) {
          errorSamples.push({
            orphan_contact_id: contactId,
            deal_id: deal.id,
            rgm,
            error: `fields: ${fieldErr?.message || fieldErr}`,
          });
        }
      }
    }
    if (DELAY_MS > 0) await sleep(DELAY_MS);
    return deal;
  }

  async function processOrphanAt(i) {
    if (stoppedAtMax || atMax()) {
      stoppedAtMax = true;
      return;
    }
    const row = orphans[i];
    scanned += 1;

    const emailCandidates = [
      normalizeEmail(row.email_norm),
      normalizeEmail(row.raw_data?.contact?.email),
    ].filter(Boolean);
    let group = null;
    let matchedEmail = null;
    for (const e of emailCandidates) {
      if (byEmail.has(e)) {
        group = byEmail.get(e);
        matchedEmail = e;
        break;
      }
    }
    if (!group) {
      orphanNoMatch += 1;
      patchJob({ processed: Math.max(i + 1, offset), sent: createdDeals, failed: errors });
      return;
    }
    orphanAluno += 1;

    const items = [...group.values()];
    const emailsSet = new Set([matchedEmail]);
    for (const it of items) {
      const e2 = normalizeEmail(it.mapped.e_mail_ad);
      if (e2) emailsSet.add(e2);
      const e3 = normalizeEmail(it.mapped._email);
      if (e3) emailsSet.add(e3);
    }
    const cpfsSet = new Set(items.map((it) => it.cpf).filter(Boolean));
    const rgmsSet = new Set(items.map((it) => it.rgm).filter(Boolean));

    const siblingId = findSiblingContactId(
      row.contact_id,
      { emails: emailsSet, cpfs: cpfsSet, rgms: rgmsSet },
      indices
    );

    if (siblingId) {
      const siblingRow = indices.byContactId.get(siblingId);
      const siblingIdStr = String(siblingId);
      // Sempre cruza com identidade live (API) — cache sozinho gerou spam
      // de deals no sibling quando SKIP_FIELDS deixava RGM vazio (28/07).
      const siblingIdent = await getMergedSiblingIdentity(siblingIdStr, siblingRow);
      const siblingRgms = siblingIdent.rgms;
      const siblingCpfs = siblingIdent.cpfs;

      const missingItems = items.filter((it) => {
        if (it.rgm && siblingRgms.has(it.rgm)) return false;
        // Sem RGM: se sibling já tem qualquer deal / mesmo CPF, não inventa outro.
        if (!it.rgm) {
          if (siblingIdent.dealCount > 0) return false;
          if (it.cpf && siblingCpfs.has(it.cpf)) return false;
        }
        // Mesmo CPF + sibling já cobre esse RGM via claim da run.
        if (it.rgm && claimedDealKeys.has(`${siblingIdStr}:rgm:${it.rgm}`)) return false;
        return true;
      });

      if (!missingItems.length) {
        dupContactSkip += 1;
        if (samples.length < 25) {
          samples.push({
            type: 'dup_contact_skip',
            orphan_contact_id: row.contact_id,
            sibling_contact_id: siblingId,
            email: matchedEmail,
            rgms: [...rgmsSet],
            sibling_rgms: [...siblingRgms],
          });
        }
        patchJob({ processed: Math.max(i + 1, offset), sent: createdDeals, failed: errors });
        return;
      }

      for (const it of missingItems) {
        if (atMax()) {
          stoppedAtMax = true;
          break;
        }
        // Re-check claim/live após creates anteriores no mesmo loop/workers.
        if (it.rgm && (siblingRgms.has(it.rgm) || claimedDealKeys.has(`${siblingIdStr}:rgm:${it.rgm}`))) {
          skippedDuplicateRgm += 1;
          continue;
        }
        dealsWouldCreateOnSibling += 1;
        const classification = classifyMatriculado(it.row, {
          inRematricula: inSet(remat, it.cpf, it.rgm),
          inCaa: inSet(caa, it.cpf, it.rgm),
          inDoc: inSet(doc, it.cpf, it.rgm),
          inInad: inSet(inad, it.cpf, it.rgm),
          inBb: inSet(bb, it.cpf, it.rgm),
          inEvasao: inSet(evasao, it.cpf, it.rgm),
        });
        if (samples.length < 25) {
          samples.push({
            type: 'extra_deal_on_sibling',
            orphan_contact_id: row.contact_id,
            sibling_contact_id: siblingId,
            email: matchedEmail,
            rgm: it.rgm,
            curso: it.curso,
            stage: classification.stageName,
          });
        }
        if (!dryRun) {
          try {
            const nome = siblingRow?.nome || it.mapped._nome_full || 'Aluno SIAA';
            const created = await createOneDeal({
              contactId: siblingId,
              nome,
              it,
              classification,
            });
            if (created && it.rgm) siblingRgms.add(it.rgm);
            if (created && it.cpf) siblingCpfs.add(it.cpf);
          } catch (err) {
            errors += 1;
            if (errorSamples.length < 25) {
              errorSamples.push({
                orphan_contact_id: row.contact_id,
                sibling_contact_id: siblingId,
                rgm: it.rgm,
                error: err?.message || String(err),
              });
            }
          }
        }
      }
    } else {
      // Orphan path: live-check default ON. Com LIVE_CHECK=0 ainda bloqueia se
      // já claimamos RGM neste processo (reentrada / concorrência).
      if (!dryRun && liveCheck && (await liveContactHasAnyDeal(row.contact_id))) {
        skippedAlreadyHasDeal += 1;
        patchJob({ processed: Math.max(i + 1, offset), sent: createdDeals, failed: errors });
        return;
      }
      const orphanRgms = rgmsOnCacheRow(row);
      for (const it of items) {
        if (atMax()) {
          stoppedAtMax = true;
          break;
        }
        if (it.rgm && (orphanRgms.has(it.rgm) || claimedDealKeys.has(`${row.contact_id}:rgm:${it.rgm}`))) {
          skippedDuplicateRgm += 1;
          continue;
        }
        dealsWouldCreateOnOrphan += 1;
        const classification = classifyMatriculado(it.row, {
          inRematricula: inSet(remat, it.cpf, it.rgm),
          inCaa: inSet(caa, it.cpf, it.rgm),
          inDoc: inSet(doc, it.cpf, it.rgm),
          inInad: inSet(inad, it.cpf, it.rgm),
          inBb: inSet(bb, it.cpf, it.rgm),
          inEvasao: inSet(evasao, it.cpf, it.rgm),
        });
        if (samples.length < 25) {
          samples.push({
            type: 'orphan_aluno',
            orphan_contact_id: row.contact_id,
            email: matchedEmail,
            rgm: it.rgm,
            curso: it.curso,
            stage: classification.stageName,
          });
        }
        if (!dryRun) {
          try {
            const nome = row.nome || it.mapped._nome_full || 'Aluno SIAA';
            const created = await createOneDeal({
              contactId: row.contact_id,
              nome,
              it,
              classification,
            });
            if (created && it.rgm) orphanRgms.add(it.rgm);
          } catch (err) {
            errors += 1;
            if (errorSamples.length < 25) {
              errorSamples.push({
                orphan_contact_id: row.contact_id,
                rgm: it.rgm,
                error: err?.message || String(err),
              });
            }
          }
        }
      }
    }

    patchJob({
      processed: Math.max(i + 1, offset),
      sent: dryRun ? dealsWouldCreateOnOrphan + dealsWouldCreateOnSibling : createdDeals,
      failed: errors,
    });
  }

  let nextIndex = offset;
  const worker = async () => {
    while (true) {
      if (stoppedAtMax || atMax()) return;
      const idx = nextIndex++;
      if (idx >= orphans.length) return;
      await processOrphanAt(idx);
    }
  };
  await Promise.all(Array.from({ length: concurrency }, () => worker()));

  const result = {
    ok: true,
    dry_run: dryRun,
    matriculados_snapshot_id: matSnap.id,
    matriculados_file: matSnap.file_name || null,
    index: { by_email: byEmail.size },
    cache_total: cacheRows.length,
    orphans_total: orphans.length,
    orphans_scanned: scanned,
    orphan_aluno: orphanAluno,
    orphan_no_match: orphanNoMatch,
    dup_contact_skip: dupContactSkip,
    deals_would_create_on_orphan: dealsWouldCreateOnOrphan,
    deals_would_create_on_sibling: dealsWouldCreateOnSibling,
    created_deals: dryRun ? 0 : createdDeals,
    errors: dryRun ? 0 : errors,
    skipped_already_has_deal_live: dryRun ? 0 : skippedAlreadyHasDeal,
    skipped_duplicate_rgm: skippedDuplicateRgm,
    max_creates: maxCreates,
    offset,
    concurrency,
    live_check: liveCheck,
    skip_fields_all: skipFieldsAll,
    delay_ms: DELAY_MS,
    stopped_at_max: stoppedAtMax,
    samples,
    error_samples: errorSamples,
  };

  patchJob({
    phase: 'done',
    status: 'completed',
    finished_at: new Date().toISOString(),
    result,
    status_message: dryRun ? 'Prévia pronta' : 'Provisionamento concluído',
  });

  console.log('[novo-crm-orphan-provision] done', JSON.stringify({ ...result, samples: undefined, error_samples: undefined }));
  return result;
}

/** @type {Map<string, object>} */
const jobs = new Map();
let runningJobId = null;

/**
 * Prévia síncrona (dry-run).
 * @param {{ maxCreates?: number }} opts
 */
export async function previewOrphanAlunoProvision(opts = {}) {
  return runOrphanAlunoProvision({ maxCreates: opts.maxCreates, dryRun: true });
}

/**
 * Apply em background. Retorna jobId.
 * @param {{ maxCreates?: number, offset?: number, liveCheck?: boolean }} opts
 */
export function startOrphanAlunoProvisionApplyBackground(opts = {}) {
  if (runningJobId && jobs.get(runningJobId)?.status === 'running') {
    return { started: false, jobId: runningJobId, error: 'Provisionamento de órfãos já em andamento' };
  }
  const jobId = randomUUID();
  const entry = {
    jobId,
    status: 'running',
    dry_run: false,
    total: 0,
    processed: 0,
    sent: 0,
    failed: 0,
    phase: 'starting',
    status_message: 'Iniciando…',
    started_at: new Date().toISOString(),
    finished_at: null,
    result: null,
    error: null,
  };
  jobs.set(jobId, entry);
  runningJobId = jobId;

  void runOrphanAlunoProvision({
    maxCreates: opts.maxCreates,
    offset: opts.offset,
    liveCheck: opts.liveCheck,
    dryRun: false,
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

export function getOrphanAlunoProvisionJob(jobId) {
  return jobs.get(String(jobId || '')) || null;
}

export function getRunningOrphanAlunoProvisionJob() {
  if (!runningJobId) return null;
  const j = jobs.get(runningJobId);
  return j?.status === 'running' ? j : null;
}
