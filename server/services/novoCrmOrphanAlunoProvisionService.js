/**
 * Provisionamento / dedupe de órfãos + incompletos no Novo CRM.
 *
 * Match matriculados: e-mail **ou telefone** (além de cpf/rgm no sibling).
 *
 * Órfão (sem deal):
 *   - Sem sibling → cria 1 deal por RGM no próprio órfão.
 *   - Sibling falta RGM → cria no sibling.
 *   - Sibling cobre tudo → dup_skip_no_deal (não cria deal Perdido fantasma).
 *
 * Incompleto (tem deal, sem CPF e/ou RGM no espelho):
 *   - Sibling “bom” → move deal(s) do contact ruim para Perdido.
 *   - Sem sibling → empty-only fill no deal (enrich leve).
 *
 * Nunca cria segundo contact. Nunca apaga contact.
 *
 * Env: NOVO_CRM_ORPHAN_* (delay/concurrency/max/offset/live_check)
 * scope: orphans | incomplete | both (default both no dedupe endpoint)
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
  normalizePhone,
  normalizeRgm,
} from '../utils/novoCrmCacheNormalize.js';
import {
  classifyMatriculado,
  getNovoCrmDealFieldIds,
  getNovoCrmStageIds,
  isCaaWithinRetencaoWindow,
  isUntouchableStageId,
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
  updateDeal,
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
 * Índice matriculados por e-mail e telefone → grupo de deals (por RGM).
 * @param {string} snapshotId
 * @returns {Promise<{ byEmail: Map<string, Map<string, object>>, byPhone: Map<string, Map<string, object>> }>}
 */
async function buildAlunoMatchIndex(snapshotId) {
  /** @type {Map<string, Map<string, object>>} */
  const byEmail = new Map();
  /** @type {Map<string, Map<string, object>>} */
  const byPhone = new Map();

  const addTo = (map, key, item) => {
    if (!key) return;
    let group = map.get(key);
    if (!group) {
      group = new Map();
      map.set(key, group);
    }
    const gkey = item.rgm || `_norgm_${group.size}`;
    if (!group.has(gkey)) group.set(gkey, item);
  };

  await baseUploadRepo.forEachRowDataForSnapshot('matriculados', snapshotId, (row) => {
    const mapped = extractMatriculadosMappedValues(row);
    const cpf = normalizeCpf(cpfDigitsFromExcelCell(mapped.cpf || row.CPF || ''));
    const rgmDisp = displayRgmFromMatriculadosRow(row);
    const rgm = normalizeRgm(rgmDisp || mapped.rgm);
    const phone = normalizePhone(mapped._phone || mapped.telefone_comercial);
    const item = { row, mapped, cpf, rgm, curso: mapped.curso, phone };

    const email1 = normalizeEmail(mapped._email);
    const email2 = normalizeEmail(mapped.e_mail_ad);
    addTo(byEmail, email1, item);
    if (email2 && email2 !== email1) addTo(byEmail, email2, item);
    addTo(byPhone, phone, item);
  });

  return { byEmail, byPhone };
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
 * Índices do cache (contact_id, email, phone, cpf, rgm).
 */
function buildCacheIndices(cacheRows) {
  const byContactId = new Map();
  const byEmail = new Map();
  const byPhone = new Map();
  const byCpf = new Map();
  const byRgm = new Map();

  for (const row of cacheRows) {
    const id = String(row.contact_id);
    byContactId.set(id, row);

    const email1 = normalizeEmail(row.email_norm);
    const email2 = normalizeEmail(row.raw_data?.contact?.email);
    addToMultiMap(byEmail, email1, id);
    if (email2 && email2 !== email1) addToMultiMap(byEmail, email2, id);

    const phone1 = normalizePhone(row.phone_norm);
    const phone2 = normalizePhone(row.raw_data?.contact?.phone);
    addToMultiMap(byPhone, phone1, id);
    if (phone2 && phone2 !== phone1) addToMultiMap(byPhone, phone2, id);

    const cpf1 = normalizeCpf(row.cpf_norm);
    addToMultiMap(byCpf, cpf1, id);

    for (const rgm of rgmsOnCacheRow(row)) addToMultiMap(byRgm, rgm, id);

    for (const deal of dealsFromCacheRow(row)) {
      const cpf2 = normalizeCpf(dealCustomValue(deal, ['cpf', 'documento', 'taxid']));
      if (cpf2) addToMultiMap(byCpf, cpf2, id);
    }
  }

  return { byContactId, byEmail, byPhone, byCpf, byRgm };
}

function siblingCompletenessScore(row) {
  if (!row) return 0;
  let s = 0;
  if (normalizeCpf(row.cpf_norm)) s += 2;
  if (rgmsOnCacheRow(row).size > 0) s += 2;
  if (row.primary_deal_id || dealsFromCacheRow(row).length > 0) s += 1;
  return s;
}

/**
 * Sibling com deal que compartilha email/phone/cpf/rgm. Prefere o mais completo.
 * @returns {string|null}
 */
function findSiblingContactId(orphanContactId, keys, indices) {
  const candidateIds = new Set();
  for (const e of keys.emails || []) for (const id of indices.byEmail.get(e) || []) candidateIds.add(id);
  for (const p of keys.phones || []) for (const id of indices.byPhone.get(p) || []) candidateIds.add(id);
  for (const c of keys.cpfs || []) for (const id of indices.byCpf.get(c) || []) candidateIds.add(id);
  for (const r of keys.rgms || []) for (const id of indices.byRgm.get(r) || []) candidateIds.add(id);
  candidateIds.delete(String(orphanContactId));

  const withDeal = [...candidateIds].filter((id) => {
    const row = indices.byContactId.get(id);
    return row && (row.primary_deal_id || dealsFromCacheRow(row).length > 0);
  });
  if (!withDeal.length) return null;
  withDeal.sort((a, b) => {
    const sa = siblingCompletenessScore(indices.byContactId.get(a));
    const sb = siblingCompletenessScore(indices.byContactId.get(b));
    return sb - sa || String(a).localeCompare(String(b));
  });
  return withDeal[0];
}

function contactPhones(row) {
  return [
    normalizePhone(row.phone_norm),
    normalizePhone(row.raw_data?.contact?.phone),
  ].filter(Boolean);
}

function contactEmails(row) {
  return [
    normalizeEmail(row.email_norm),
    normalizeEmail(row.raw_data?.contact?.email),
  ].filter(Boolean);
}

/** Tem deal mas falta CPF e/ou RGM no espelho. */
function isIncompleteWithDeal(row) {
  if (!row.primary_deal_id && dealsFromCacheRow(row).length === 0) return false;
  const hasCpf = Boolean(normalizeCpf(row.cpf_norm));
  const hasRgm = rgmsOnCacheRow(row).size > 0 || Boolean(normalizeRgm(row.rgm_norm));
  return !hasCpf || !hasRgm;
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
 * @param {{
 *   dryRun?: boolean,
 *   maxCreates?: number,
 *   jobId?: string|null,
 *   scope?: 'orphans'|'incomplete'|'both',
 *   offset?: number,
 *   liveCheck?: boolean,
 * }} [opts]
 */
export async function runOrphanAlunoProvision(opts = {}) {
  const dryRun = opts.dryRun !== false;
  const maxCreates = Math.min(Math.max(Number(opts.maxCreates) || defaultMaxCreates(), 1), 20000);
  const jobId = opts.jobId || null;
  const scopeRaw = String(opts.scope || 'orphans').trim().toLowerCase();
  const scope = ['orphans', 'incomplete', 'both'].includes(scopeRaw) ? scopeRaw : 'orphans';
  const doOrphans = scope === 'orphans' || scope === 'both';
  const doIncomplete = scope === 'incomplete' || scope === 'both';

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

  patchJob({ phase: 'load_matriculados', status_message: 'Indexando matriculados (e-mail + telefone)…' });
  const matSnap = await baseUploadRepo.getLatestSnapshot('matriculados');
  if (!matSnap?.id) {
    const err = new Error('Nenhum snapshot de matriculados encontrado. Faça upload em Bases.');
    err.status = 400;
    throw err;
  }
  const { byEmail, byPhone } = await buildAlunoMatchIndex(matSnap.id);

  patchJob({ phase: 'load_bases', status_message: 'Carregando bases satélite…' });
  const [remat, caaT0Map, doc, inad, bb, evasao] = await Promise.all([
    loadIdSetFromBase('rematricula'),
    caaProtocolsRepo.loadOpenCaaT0Map(),
    loadIdSetFromBase('docs-pendentes'),
    loadIdSetFromBase('inadimplentes-vencidos'),
    loadIdSetFromBase('acessos-blackboard'),
    loadIdSetFromBase('provavel-evasao'),
  ]);

  patchJob({ phase: 'load_cache', status_message: 'Carregando cache do CRM…' });
  const cacheRows = await cacheRepo.listActiveCacheRowsForEnrichment({ scope: 'all_mapped', limit: 100000 });
  const indices = buildCacheIndices(cacheRows);
  const orphans = doOrphans
    ? cacheRows.filter((r) => !r.primary_deal_id && dealsFromCacheRow(r).length === 0)
    : [];
  const incompletes = doIncomplete ? cacheRows.filter((r) => isIncompleteWithDeal(r)) : [];

  const fieldIds = getNovoCrmDealFieldIds();
  const perdidoStageId = String(getNovoCrmStageIds().Perdido || '').trim();
  const offset = Math.max(0, Number(opts.offset ?? process.env.NOVO_CRM_ORPHAN_OFFSET) || 0);
  const liveCheckEnv = String(process.env.NOVO_CRM_ORPHAN_LIVE_CHECK ?? '1').trim();
  const liveCheck =
    opts.liveCheck != null ? Boolean(opts.liveCheck) : liveCheckEnv !== '0' && liveCheckEnv !== 'false';
  const concurrency = dryRun ? 1 : orphanConcurrency();

  let scanned = 0;
  let orphanAluno = 0;
  let orphanNoMatch = 0;
  let matchedEmail = 0;
  let matchedPhone = 0;
  let dupContactSkip = 0;
  let dupSkipNoDeal = 0;
  let dupToPerdido = 0;
  let dealsMovedPerdido = 0;
  let incompleteScanned = 0;
  let incompleteNoMatch = 0;
  let incompleteEnriched = 0;
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
    `[novo-crm-orphan-provision] start dry=${dryRun} scope=${scope} max=${maxCreates} offset=${offset} conc=${concurrency} orphans=${orphans.length} incompletes=${incompletes.length}`
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

    const emailCandidates = contactEmails(row);
    const phoneCandidates = contactPhones(row);
    let group = null;
    let matchedKey = null;
    let matchVia = null;
    for (const e of emailCandidates) {
      if (byEmail.has(e)) {
        group = byEmail.get(e);
        matchedKey = e;
        matchVia = 'email';
        break;
      }
    }
    if (!group) {
      for (const p of phoneCandidates) {
        if (byPhone.has(p)) {
          group = byPhone.get(p);
          matchedKey = p;
          matchVia = 'phone';
          break;
        }
      }
    }
    if (!group) {
      orphanNoMatch += 1;
      patchJob({ processed: Math.max(i + 1, offset), sent: createdDeals, failed: errors });
      return;
    }
    orphanAluno += 1;
    if (matchVia === 'email') matchedEmail += 1;
    if (matchVia === 'phone') matchedPhone += 1;

    const items = [...group.values()];
    const emailsSet = new Set(emailCandidates);
    const phonesSet = new Set(phoneCandidates);
    for (const it of items) {
      const e2 = normalizeEmail(it.mapped.e_mail_ad);
      if (e2) emailsSet.add(e2);
      const e3 = normalizeEmail(it.mapped._email);
      if (e3) emailsSet.add(e3);
      const ph = normalizePhone(it.phone || it.mapped._phone);
      if (ph) phonesSet.add(ph);
    }
    const cpfsSet = new Set(items.map((it) => it.cpf).filter(Boolean));
    const rgmsSet = new Set(items.map((it) => it.rgm).filter(Boolean));

    const siblingId = findSiblingContactId(
      row.contact_id,
      { emails: emailsSet, phones: phonesSet, cpfs: cpfsSet, rgms: rgmsSet },
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
        dupSkipNoDeal += 1;
        if (samples.length < 25) {
          samples.push({
            type: 'dup_skip_no_deal',
            orphan_contact_id: row.contact_id,
            sibling_contact_id: siblingId,
            match_via: matchVia,
            match_key: matchedKey,
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
          inCaaFresh: isCaaWithinRetencaoWindow(
            caaProtocolsRepo.lookupCaaT0(caaT0Map, it.cpf, it.rgm)
          ),
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
            match_via: matchVia,
            match_key: matchedKey,
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
          inCaaFresh: isCaaWithinRetencaoWindow(
            caaProtocolsRepo.lookupCaaT0(caaT0Map, it.cpf, it.rgm)
          ),
          inDoc: inSet(doc, it.cpf, it.rgm),
          inInad: inSet(inad, it.cpf, it.rgm),
          inBb: inSet(bb, it.cpf, it.rgm),
          inEvasao: inSet(evasao, it.cpf, it.rgm),
        });
        if (samples.length < 25) {
          samples.push({
            type: 'orphan_aluno',
            orphan_contact_id: row.contact_id,
            match_via: matchVia,
            match_key: matchedKey,
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

  // === INCOMPLETE PASS ===
  if (doIncomplete && incompletes.length > 0) {
    patchJob({
      phase: 'process_incomplete',
      total: incompletes.length,
      processed: 0,
      status_message: 'Processando incompletos (dedupe + enrich)…',
    });

    let incIdx = 0;
    for (const row of incompletes) {
      incompleteScanned += 1;
      incIdx += 1;

      // Match matriculados via email then phone.
      const emailCandidates = contactEmails(row);
      const phoneCandidates = contactPhones(row);
      let group = null;
      let matchedKey = null;
      let matchVia = null;
      for (const e of emailCandidates) {
        if (byEmail.has(e)) { group = byEmail.get(e); matchedKey = e; matchVia = 'email'; break; }
      }
      if (!group) {
        for (const p of phoneCandidates) {
          if (byPhone.has(p)) { group = byPhone.get(p); matchedKey = p; matchVia = 'phone'; break; }
        }
      }
      if (!group) {
        incompleteNoMatch += 1;
        patchJob({ processed: incIdx });
        continue;
      }
      if (matchVia === 'email') matchedEmail += 1;
      else matchedPhone += 1;

      const items = [...group.values()];
      const emailsSet = new Set(emailCandidates);
      const phonesSet = new Set(phoneCandidates);
      for (const it of items) {
        const e2 = normalizeEmail(it.mapped.e_mail_ad);
        if (e2) emailsSet.add(e2);
        const e3 = normalizeEmail(it.mapped._email);
        if (e3) emailsSet.add(e3);
        const ph = normalizePhone(it.phone || it.mapped._phone);
        if (ph) phonesSet.add(ph);
      }
      const cpfsSet = new Set(items.map((it) => it.cpf).filter(Boolean));
      const rgmsSet = new Set(items.map((it) => it.rgm).filter(Boolean));

      // Find sibling more complete than this contact.
      const siblingId = findSiblingContactId(
        row.contact_id,
        { emails: emailsSet, phones: phonesSet, cpfs: cpfsSet, rgms: rgmsSet },
        indices
      );
      const currentScore = siblingCompletenessScore(row);
      const siblingRow = siblingId ? indices.byContactId.get(siblingId) : null;
      const siblingScore = siblingRow ? siblingCompletenessScore(siblingRow) : 0;

      if (siblingId && siblingRow && siblingScore > currentScore) {
        // Sibling is more complete → mark bad deals on this contact as Perdido.
        if (!perdidoStageId) {
          // Cannot resolve Perdido stage (probably missing env / wrong host) — skip.
          patchJob({ processed: incIdx });
          continue;
        }
        dupToPerdido += 1;

        // Collect all deals on this incomplete contact.
        const allDeals = dealsFromCacheRow(row);
        const primaryId = String(row.primary_deal_id || '').trim();
        if (primaryId && !allDeals.some((d) => String(d.id) === primaryId)) {
          allDeals.push({ id: primaryId });
        }

        for (const deal of allDeals) {
          if (!deal?.id) continue;
          const dealStageId = String(deal?.stageId || deal?.stage_id || '').trim();
          if (isUntouchableStageId(dealStageId)) continue;
          if (dealStageId === perdidoStageId) continue;

          dealsMovedPerdido += 1;
          if (samples.length < 25) {
            samples.push({
              type: 'dup_to_perdido',
              incomplete_contact_id: row.contact_id,
              sibling_contact_id: siblingId,
              deal_id: deal.id,
              current_stage_id: dealStageId || null,
              match_via: matchVia,
              match_key: matchedKey,
            });
          }
          if (!dryRun) {
            try {
              await updateDeal(deal.id, { stageId: perdidoStageId });
              if (DELAY_MS > 0) await sleep(DELAY_MS);
            } catch (err) {
              errors += 1;
              if (errorSamples.length < 25) {
                errorSamples.push({
                  incomplete_contact_id: row.contact_id,
                  deal_id: deal.id,
                  error: err?.message || String(err),
                });
              }
            }
          }
        }
      } else {
        // No suitable sibling → empty-only fill CPF/RGM on primary deal.
        const allDeals = dealsFromCacheRow(row);
        const primaryId = String(row.primary_deal_id || '').trim();
        const primaryDeal =
          (primaryId && allDeals.find((d) => String(d.id) === primaryId)) ||
          (primaryId ? { id: primaryId } : null) ||
          allDeals[0] ||
          null;

        if (!primaryDeal?.id || !fieldIds?.cpf) {
          patchJob({ processed: incIdx });
          continue;
        }

        const hasCpf = Boolean(normalizeCpf(row.cpf_norm));
        const hasRgm = rgmsOnCacheRow(row).size > 0 || Boolean(normalizeRgm(row.rgm_norm));
        const it = items[0];
        const enrichValues = [
          (!hasCpf && it?.cpf) ? { fieldId: fieldIds.cpf, value: it.cpf } : null,
          (!hasRgm && it?.rgm) ? { fieldId: fieldIds.rgm, value: it.rgm } : null,
        ].filter(Boolean);

        if (!enrichValues.length) {
          patchJob({ processed: incIdx });
          continue;
        }

        incompleteEnriched += 1;
        if (samples.length < 25) {
          samples.push({
            type: 'incomplete_enriched',
            contact_id: row.contact_id,
            deal_id: primaryDeal.id,
            match_via: matchVia,
            match_key: matchedKey,
            filled: enrichValues.map((v) => (v.fieldId === fieldIds.cpf ? 'cpf' : 'rgm')),
          });
        }
        if (!dryRun) {
          try {
            await updateDealCustomFields(primaryDeal.id, enrichValues, { maxRetries: 4 });
            if (DELAY_MS > 0) await sleep(DELAY_MS);
          } catch (err) {
            errors += 1;
            if (errorSamples.length < 25) {
              errorSamples.push({
                incomplete_contact_id: row.contact_id,
                deal_id: primaryDeal.id,
                error: err?.message || String(err),
              });
            }
          }
        }
      }

      patchJob({ processed: incIdx, failed: errors });
    }
  }

  const result = {
    ok: true,
    dry_run: dryRun,
    scope,
    matriculados_snapshot_id: matSnap.id,
    matriculados_file: matSnap.file_name || null,
    index: { by_email: byEmail.size, by_phone: byPhone.size },
    cache_total: cacheRows.length,
    orphans_total: orphans.length,
    orphans_scanned: scanned,
    orphan_aluno: orphanAluno,
    orphan_no_match: orphanNoMatch,
    matched_email: matchedEmail,
    matched_phone: matchedPhone,
    dup_contact_skip: dupContactSkip,
    dup_skip_no_deal: dupSkipNoDeal,
    dup_to_perdido: dupToPerdido,
    deals_would_create_on_orphan: dealsWouldCreateOnOrphan,
    deals_would_create_on_sibling: dealsWouldCreateOnSibling,
    ...(dryRun
      ? { deals_would_move_perdido: dealsMovedPerdido }
      : { deals_moved_perdido: dealsMovedPerdido }),
    incomplete_total: incompletes.length,
    incomplete_scanned: incompleteScanned,
    incomplete_no_match: incompleteNoMatch,
    incomplete_enriched: incompleteEnriched,
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
 * @param {{ maxCreates?: number, scope?: 'orphans'|'incomplete'|'both' }} opts
 */
export async function previewOrphanAlunoProvision(opts = {}) {
  return runOrphanAlunoProvision({ maxCreates: opts.maxCreates, scope: opts.scope, dryRun: true });
}

/**
 * Apply em background. Retorna jobId.
 * @param {{ maxCreates?: number, offset?: number, liveCheck?: boolean, scope?: 'orphans'|'incomplete'|'both' }} opts
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
    scope: opts.scope,
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
