/**
 * Cliente HTTP para a API da DataCrazy.
 *
 * IMPORTANTE: Mantenha o payload e os endpoints isolados nesta camada
 * para facilitar ajustes quando a documentação oficial estiver disponível.
 *
 * TODO [CURSOR]: confirmar o endpoint exato de envio de mensagem.
 *   Possíveis caminhos comuns:
 *     - POST {BASE_URL}/v1/messages
 *     - POST {BASE_URL}/v1/whatsapp/send
 *     - POST {BASE_URL}/messages/template
 *   Ajustar `SEND_MESSAGE_PATH` e o formato de `payload` conforme a doc.
 */

import * as datacrazyLeadCacheRepo from '../repositories/datacrazyLeadCacheRepository.js';
import * as activationDispatchRepo from '../repositories/activationDispatchRepository.js';
import { datacrazyCrmLimiter } from '../utils/datacrazyCrmLimiter.js';
import { lookupMasterKeysFromParts } from '../utils/activationIdentity.js';
import {
  isValidDatacrazySearchTerm,
  sanitizeContactEmail,
  sanitizeContactPhone,
} from '../utils/datacrazySearchTerm.js';

const SEND_MESSAGE_PATH = '/v1/messages';
const LIST_TEMPLATES_PATH = '/v1/templates';
const SEARCH_LEADS_PATH = '/api/v1/leads';

/** Campo adicional no lead (DataCrazy) — nome criado no CRM. */
export const ORIGEM_ATIVACAO_FIELD =
  process.env.DATACRAZY_ORIGEM_ATIVACAO_FIELD || 'origem_ativacao';

/** ID do campo `origem_ativacao` (definição no CRM — ver URL ao editar manualmente). */
export const ORIGEM_ATIVACAO_FIELD_ID =
  process.env.DATACRAZY_ORIGEM_ATIVACAO_FIELD_ID || '';

/**
 * Valor gravado em `origem_ativacao` por categoria do disparador.
 * @type {Record<string, string>}
 */
export const ORIGEM_ATIVACAO_BY_CATEGORY = {
  'docs-pendentes': 'Doc',
  financeiro: 'Inad',
  'processos-caa': 'caa',
  'provavel-evasao': 'Evasao',
  'acessos-blackboard': 'BB',
  'aguardando-inicio': 'AguardInicio',
  'conteudo-previo': 'Previo',
  rematricula: 'Remat',
};

export function origemAtivacaoForCategory(category) {
  return ORIGEM_ATIVACAO_BY_CATEGORY[category] ?? null;
}

/** Mensagem exibida na UI quando origem_ativacao não grava no CRM. */
export const ORIGEM_ATIVACAO_BLOCK_MESSAGE =
  'Não foi possível gravar o campo origem_ativacao no DataCrazy. O disparo foi interrompido porque as respostas dos alunos não serão mensuradas — a automação do CRM depende desse campo para enviar cliques ao n8n. Verifique DATACRAZY_CRM_BASE_URL, DATACRAZY_ORIGEM_ATIVACAO_FIELD_ID e permissões da API.';

function getConfig() {
  const apiKey = process.env.DATACRAZY_API_KEY;
  const baseUrl = (process.env.DATACRAZY_BASE_URL || '').replace(/\/+$/, '');

  if (!apiKey) {
    throw new Error(
      'DATACRAZY_API_KEY não configurada. Defina no arquivo .env.'
    );
  }
  if (!baseUrl) {
    throw new Error(
      'DATACRAZY_BASE_URL não configurada. Defina no arquivo .env.'
    );
  }

  return { apiKey, baseUrl };
}

/** Base do CRM web (campos adicionais); distinto da API pública api.g1. */
function getCrmBaseUrl() {
  const explicit = (process.env.DATACRAZY_CRM_BASE_URL || '').replace(/\/+$/, '');
  if (explicit) return explicit;
  const api = (process.env.DATACRAZY_BASE_URL || 'https://api.g1.datacrazy.io').replace(
    /\/+$/,
    ''
  );
  return api.replace(/:\/\/api\./i, '://crm.');
}

function buildHeaders(apiKey) {
  return {
    Authorization: `Bearer ${apiKey}`,
    'Content-Type': 'application/json',
    Accept: 'application/json',
  };
}

/**
 * Constrói o payload esperado pela DataCrazy a partir de um envio padronizado
 * vindo do frontend.
 *
 * TODO [CURSOR]: ajustar a estrutura do payload de acordo com a doc oficial
 * da DataCrazy (campos obrigatórios podem variar).
 */
function buildSendTemplatePayload({ phone, templateName, language, variables }) {
  const components = [];

  if (variables && Object.keys(variables).length > 0) {
    components.push({
      type: 'body',
      parameters: Object.values(variables).map((value) => ({
        type: 'text',
        text: String(value ?? ''),
      })),
    });
  }

  return {
    to: phone,
    type: 'template',
    template: {
      name: templateName,
      language: { code: language || 'pt_BR' },
      components,
    },
    metadata: {
      variables: variables || {},
    },
  };
}

async function sendTemplateMessage({ phone, templateName, language, variables }) {
  const { apiKey, baseUrl } = getConfig();
  const url = `${baseUrl}${SEND_MESSAGE_PATH}`;
  const payload = buildSendTemplatePayload({ phone, templateName, language, variables });

  let response;
  try {
    response = await fetch(url, {
      method: 'POST',
      headers: buildHeaders(apiKey),
      body: JSON.stringify(payload),
    });
  } catch (err) {
    throw new Error(`Falha de rede ao chamar DataCrazy: ${err.message}`);
  }

  const text = await response.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = { raw: text };
  }

  if (!response.ok) {
    const message =
      data?.error?.message ||
      data?.message ||
      data?.raw ||
      `DataCrazy respondeu com status ${response.status}`;
    const error = new Error(message);
    error.status = response.status;
    error.providerResponse = data;
    throw error;
  }

  // TODO [CURSOR]: confirmar o nome do campo do ID no retorno (id, messageId, message_id, etc.)
  const messageId =
    data?.id ||
    data?.messageId ||
    data?.message_id ||
    data?.data?.id ||
    null;

  return {
    messageId,
    raw: data,
  };
}

async function listTemplates() {
  const { apiKey, baseUrl } = getConfig();
  const url = `${baseUrl}${LIST_TEMPLATES_PATH}`;

  const response = await fetch(url, {
    method: 'GET',
    headers: buildHeaders(apiKey),
  });

  const text = await response.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = { raw: text };
  }

  if (!response.ok) {
    const message =
      data?.error?.message ||
      data?.message ||
      `DataCrazy respondeu com status ${response.status}`;
    const error = new Error(message);
    error.status = response.status;
    error.providerResponse = data;
    throw error;
  }

  // TODO [CURSOR]: ajustar mapeamento conforme a estrutura real da resposta.
  const list = Array.isArray(data) ? data : data?.data || data?.templates || [];

  return list.map((tpl) => ({
    id: tpl.id || tpl._id || tpl.name,
    name: tpl.name,
    language: tpl.language || tpl.languageCode || 'pt_BR',
    status: (tpl.status || 'APPROVED').toUpperCase(),
    category: (tpl.category || 'MARKETING').toUpperCase(),
    components: tpl.components || [],
  }));
}

function extractAdditionalFieldValue(lead, fieldName, fieldId) {
  if (!lead || typeof lead !== 'object') return null;
  const bags = [
    lead.additionalFields,
    lead.additional_fields,
    lead.customFields,
    lead.custom_fields,
  ];
  for (const bag of bags) {
    if (!bag) continue;
    if (Array.isArray(bag)) {
      for (const item of bag) {
        if (!item || typeof item !== 'object') continue;
        const id = String(item.id ?? item.fieldId ?? item.field_id ?? item.definitionId ?? '');
        const name = String(item.name ?? item.field ?? item.key ?? item.slug ?? '');
        if (id === fieldId || name === fieldName) {
          const v = item.value ?? item.val ?? item.data;
          return v == null ? null : String(v);
        }
      }
    } else if (typeof bag === 'object') {
      if (bag[fieldName] != null) return String(bag[fieldName]);
      if (bag[fieldId] != null) return String(bag[fieldId]);
    }
  }
  return null;
}

async function getLeadById(leadId) {
  const { apiKey, baseUrl } = getConfig();
  const id = String(leadId ?? '').trim();
  if (!id) throw new Error('leadId obrigatório');
  const params = new URLSearchParams();
  params.set('complete[additionalFields]', 'true');
  const url = `${baseUrl}/api/v1/leads/${encodeURIComponent(id)}?${params.toString()}`;
  const response = await datacrazyApiFetch(url, { method: 'GET', headers: buildHeaders(apiKey) });
  const text = await response.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = { raw: text };
  }
  if (!response.ok) {
    const message =
      data?.error?.message || data?.message || `DataCrazy respondeu com status ${response.status}`;
    const error = new Error(message);
    error.status = response.status;
    throw error;
  }
  return data?.data ?? data;
}

async function searchLeads(opts = {}) {
  const { apiKey, baseUrl } = getConfig();
  const searchTerm = opts.search ? String(opts.search).trim() : '';
  if (searchTerm && !isValidDatacrazySearchTerm(searchTerm)) {
    return { data: [], count: 0, skipped_invalid_search: true };
  }

  const params = new URLSearchParams();
  if (searchTerm) params.set('search', searchTerm);
  const maxTake = Number(process.env.DATACRAZY_LEADS_PAGE_SIZE) || 100;
  params.set('take', String(Math.min(Math.max(opts.take ?? 10, 1), maxTake)));
  params.set('skip', String(Math.max(opts.skip ?? 0, 0)));
  if (opts.completeAdditionalFields === true) {
    params.set('complete[additionalFields]', 'true');
  }
  const url = `${baseUrl}${SEARCH_LEADS_PATH}?${params.toString()}`;

  const maxAttempts = Math.max(Number(process.env.DATACRAZY_SEARCH_MAX_ATTEMPTS) || 3, 1);
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    await datacrazyCrmLimiter.acquire();
    const response = await fetch(url, { method: 'GET', headers: buildHeaders(apiKey) });
    const text = await response.text();
    let data = null;
    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      data = { raw: text };
    }

    if (response.status === 429 && attempt < maxAttempts) {
      await sleep(Math.min(800 * attempt, 4000));
      continue;
    }

    if (!response.ok) {
      const message =
        data?.error?.message || data?.message || `DataCrazy respondeu com status ${response.status}`;
      const error = new Error(message);
      error.status = response.status;
      throw error;
    }
    const list = Array.isArray(data?.data) ? data.data : Array.isArray(data) ? data : [];
    return { data: list, count: data?.count ?? list.length };
  }

  return { data: [], count: 0 };
}

export function normalizeEmailForMatch(v) {
  return sanitizeContactEmail(v);
}

function normalizePhoneDigits(v) {
  return sanitizeContactPhone(v);
}

export function leadPhoneDigits(lead) {
  return String(lead?.rawPhone || lead?.phone || '')
    .replace(/\D/g, '')
    .replace(/^55/, '');
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** GET/PUT/POST na API/CRM DataCrazy com rate limit + retry em 429. */
async function datacrazyApiFetch(url, init = {}) {
  const maxAttempts = Math.max(Number(process.env.DATACRAZY_SEARCH_MAX_ATTEMPTS) || 3, 1);
  let lastError = null;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    await datacrazyCrmLimiter.acquire();
    let response;
    try {
      response = await fetch(url, init);
    } catch (err) {
      lastError = err;
      if (attempt < maxAttempts) {
        await sleep(Math.min(800 * attempt, 4000));
        continue;
      }
      const e = new Error(`Falha de rede DataCrazy: ${err.message}`);
      e.cause = err;
      throw e;
    }
    if (response.status === 429 && attempt < maxAttempts) {
      await sleep(Math.min(1200 * attempt, 6000));
      continue;
    }
    return response;
  }
  throw lastError || new Error('DataCrazy: tentativas esgotadas');
}

function isRateLimitErrorMessage(msg) {
  const s = String(msg ?? '').toLowerCase();
  return s.includes('too many requests') || s.includes('rate limit') || s.includes('429');
}

function getActivationLookupMode() {
  return String(process.env.DATACRAZY_ACTIVATION_LOOKUP_MODE ?? 'hybrid').toLowerCase();
}

function isCacheOnlyLookupMode() {
  return getActivationLookupMode() === 'cache_only';
}

function isCacheFirstLookupMode() {
  return getActivationLookupMode() === 'cache_first';
}

/** hybrid / cache_first / lotes grandes: pula rajada de ?search= no preflight. */
function shouldSkipBulkPreflight(personCount) {
  const mode = getActivationLookupMode();
  if (mode === 'bulk_search') return false;
  if (mode === 'cache_first' || mode === 'hybrid' || mode === 'cache_only') return true;
  const threshold = Math.max(Number(process.env.DATACRAZY_HYBRID_AUTO_THRESHOLD) || 150, 1);
  return personCount >= threshold;
}

function resolveLookupModeLabel() {
  const mode = getActivationLookupMode();
  if (mode === 'bulk_search') return 'bulk_search';
  if (mode === 'cache_first') return 'cache_first';
  if (mode === 'cache_only') return 'cache_only';
  return 'hybrid';
}

function leadFromCacheRow(row) {
  return (
    row.raw_lead || {
      id: row.datacrazy_lead_id,
      email: row.email_norm,
      rawPhone: row.phone_norm,
      phone: row.phone_norm,
      name: row.nome,
      taxId: row.cpf,
    }
  );
}

function applyCacheRowToIndex(row, byEmail, byPhone, byCpf, remainingEmails, remainingPhones) {
  const lead = leadFromCacheRow(row);
  mergeLeadIntoMaps(lead, byEmail, byPhone, byCpf);
  if (row.email_norm) remainingEmails.delete(row.email_norm);
  if (row.phone_norm) remainingPhones.delete(row.phone_norm);
  const cpf = normalizeCpfFromString(row.cpf);
  if (cpf && !byCpf.has(cpf)) byCpf.set(cpf, lead);
}

function normalizeCpfFromString(v) {
  const d = String(v ?? '').replace(/\D/g, '');
  return d.length === 11 ? d : '';
}

/** Pool de resolução API — N buscas em paralelo (default 6), não serial. */
let resolveActive = 0;
/** @type {Array<{ task: () => Promise<unknown>, resolve: Function, reject: Function }>} */
const resolveWaitQueue = [];

function getResolveConcurrency() {
  return Math.max(
    Math.min(Number(process.env.DATACRAZY_RESOLVE_CONCURRENCY) || 4, 8),
    1
  );
}

function drainResolveQueue() {
  while (resolveActive < getResolveConcurrency() && resolveWaitQueue.length > 0) {
    const entry = resolveWaitQueue.shift();
    if (!entry) break;
    resolveActive += 1;
    Promise.resolve()
      .then(entry.task)
      .then(entry.resolve, entry.reject)
      .finally(() => {
        resolveActive -= 1;
        drainResolveQueue();
      });
  }
}

function enqueueLeadResolve(task) {
  return new Promise((resolve, reject) => {
    resolveWaitQueue.push({ task, resolve, reject });
    drainResolveQueue();
  });
}

function pickLeadFromSearchPage(page, contact) {
  const list = page?.data || [];
  if (!list.length) return null;
  const cpf = String(contact.cpf ?? '').replace(/\D/g, '');
  const email = normalizeEmailForMatch(contact.email);
  const phone = normalizePhoneDigits(contact.phone);
  for (const lead of list) {
    if (cpf.length === 11 && cpfDigitsFromLead(lead) === cpf) return lead;
  }
  if (email) {
    for (const lead of list) {
      if (normalizeEmailForMatch(lead.email) === email) return lead;
    }
  }
  if (phone) {
    for (const lead of list) {
      const p = leadPhoneDigits(lead);
      if (p === phone || p.endsWith(phone) || phone.endsWith(p)) return lead;
    }
  }
  return list[0];
}

function directSearchSettings() {
  return {
    concurrency: Math.max(
      Math.min(Number(process.env.DATACRAZY_DIRECT_SEARCH_CONCURRENCY) || 4, 12),
      1
    ),
    delayMs: Math.max(Number(process.env.DATACRAZY_DIRECT_SEARCH_DELAY_MS) || 250, 0),
    cooldownMs: Math.max(Number(process.env.DATACRAZY_RATE_LIMIT_COOLDOWN_MS) || 2000, 500),
  };
}

/** Pausa compartilhada só quando a API retorna 429 (não entre todo lote). */
let directSearchCooldownUntil = 0;

/** Busca direta com retries; distingue 429 de “não achou”. */
async function searchLeadsDirect(term, opts = {}) {
  const { cooldownMs } = directSearchSettings();
  const maxOuter = Math.max(
    Number(opts.maxAttempts ?? process.env.DATACRAZY_SEARCH_MAX_ATTEMPTS) || 5,
    1
  );
  for (let outer = 1; outer <= maxOuter; outer++) {
    const now = Date.now();
    if (now < directSearchCooldownUntil) {
      await sleep(directSearchCooldownUntil - now);
    }
    try {
      const page = await searchLeads({ search: term, take: 5 });
      return { page, rateLimited: false };
    } catch (err) {
      const rateLimited = err.status === 429 || isRateLimitErrorMessage(err.message);
      if (rateLimited && outer < maxOuter) {
        directSearchCooldownUntil = Date.now() + cooldownMs * outer;
        await sleep(cooldownMs * outer);
        continue;
      }
      if (rateLimited) {
        console.warn(`[datacrazy] direct search "${term}" rate limit após ${maxOuter} tentativas`);
        return { page: null, rateLimited: true };
      }
      console.warn(`[datacrazy] direct search "${term}" falhou: ${err.message}`);
      return { page: null, rateLimited: false };
    }
  }
  return { page: null, rateLimited: true };
}

/**
 * Executa buscas diretas: lote paralelo (baixa concorrência) + retry serial em 429.
 * @param {string[]} terms
 * @param {(term: string, page: { data: object[] }|null, rateLimited: boolean) => void} onResult
 */
async function runDirectSearchTerms(terms, onResult) {
  const { concurrency, delayMs } = directSearchSettings();
  const rateLimitedTerms = [];

  for (let i = 0; i < terms.length; i += concurrency) {
    const slice = terms.slice(i, i + concurrency);
    const pages = await Promise.all(slice.map((term) => searchLeadsDirect(term)));
    for (let j = 0; j < slice.length; j++) {
      const res = pages[j];
      if (res?.rateLimited) {
        rateLimitedTerms.push(slice[j]);
        continue;
      }
      onResult(slice[j], res?.page ?? null, false);
    }
    if (i + concurrency < terms.length) {
      await sleep(delayMs > 0 ? delayMs : 200);
    }
  }

  if (!rateLimitedTerms.length) return;

  const serialMax = Math.max(Number(process.env.DATACRAZY_SERIAL_RETRY_MAX_ATTEMPTS) || 8, 1);
  const serialGap = Math.max(Number(process.env.DATACRAZY_SERIAL_RETRY_GAP_MS) || 500, 200);
  console.warn(
    `[datacrazy] ${rateLimitedTerms.length} busca(s) com 429 no lote paralelo — retry serial (${serialMax} tentativas/termo)...`
  );
  let recovered = 0;
  for (const term of rateLimitedTerms) {
    await sleep(serialGap);
    const res = await searchLeadsDirect(term, { maxAttempts: serialMax });
    if (res.rateLimited) {
      onResult(term, null, true);
      continue;
    }
    onResult(term, res.page ?? null, false);
    if (res.page?.data?.length) recovered += 1;
  }
  console.warn(
    `[datacrazy] retry serial: ${recovered}/${rateLimitedTerms.length} termo(s) com resultado`
  );
}

const SHARED_INDEX_TTL_MS = 20 * 60 * 1000;
const sharedLeadsIndex = {
  expires: 0,
  byEmail: new Map(),
  byPhone: new Map(),
  byCpf: new Map(),
};

function cpfDigitsFromLead(lead) {
  const raw = lead?.taxId ?? lead?.tax_id ?? lead?.cpf ?? '';
  const d = String(raw).replace(/\D/g, '');
  return d.length === 11 ? d : '';
}

function personFoundInIndex(person, byEmail, byPhone, byCpf) {
  return (
    (person.email && byEmail.has(person.email)) ||
    (person.phone && byPhone.has(person.phone)) ||
    (person.cpf && byCpf.has(person.cpf))
  );
}

function mergeLeadIntoMaps(lead, byEmail, byPhone, byCpf) {
  const e = normalizeEmailForMatch(lead.email);
  const p = leadPhoneDigits(lead);
  const c = cpfDigitsFromLead(lead);
  if (e && !byEmail.has(e)) byEmail.set(e, lead);
  if (p && !byPhone.has(p)) byPhone.set(p, lead);
  if (c && !byCpf.has(c)) byCpf.set(c, lead);
}

async function buildLeadsLookupIndex(needed = {}) {
  const useShared = sharedLeadsIndex.expires > Date.now();
  const byEmail = useShared ? new Map(sharedLeadsIndex.byEmail) : new Map();
  const byPhone = useShared ? new Map(sharedLeadsIndex.byPhone) : new Map();
  const byCpf = useShared ? new Map(sharedLeadsIndex.byCpf) : new Map();

  // Normaliza entrada: aceita formato novo `{contacts: [{email, phone}]}` (preferido,
  // permite dedupe por pessoa) e o antigo `{emails, phones}` (sem vínculo).
  // O novo formato evita disparar 2 chamadas (email + telefone) pra mesma pessoa.
  const contacts = Array.isArray(needed.contacts) ? needed.contacts : null;
  const remainingEmails = new Set();
  const remainingPhones = new Set();
  /** @type {Array<{ email: string, phone: string, cpf: string, rgm?: string }>} */
  const personList = [];
  if (contacts) {
    const seenKey = new Set();
    for (const c of contacts) {
      const e = sanitizeContactEmail(c?.email);
      const p = sanitizeContactPhone(c?.phone ?? c?.telefone);
      const cpfDigits = String(c?.cpf ?? '').replace(/\D/g, '');
      const cpf = cpfDigits.length === 11 ? cpfDigits : '';
      const rgm = String(c?.rgm ?? '').trim();
      if (!e && !p && !cpf) continue;
      const key = `${e}::${p}::${cpf}::${rgm}`;
      if (seenKey.has(key)) continue;
      seenKey.add(key);
      if (e && !byEmail.has(e)) remainingEmails.add(e);
      if (p && !byPhone.has(p)) remainingPhones.add(p);
      if ((e && byEmail.has(e)) || (p && byPhone.has(p)) || (cpf && byCpf.has(cpf))) continue;
      personList.push({ email: e || '', phone: p || '', cpf: cpf || '', rgm: rgm || '' });
    }
  } else {
    for (const e of needed.emails || []) {
      const norm = sanitizeContactEmail(e);
      if (norm && !byEmail.has(norm)) remainingEmails.add(norm);
    }
    for (const p of needed.phones || []) {
      const norm = sanitizeContactPhone(p);
      if (norm && !byPhone.has(norm)) remainingPhones.add(norm);
    }
  }

  // FASE 0 (Onda 2): consulta cache persistente Postgres por CPF antes de
  // bater na API DataCrazy. Hits quentes (~<1ms cada) eliminam chamadas de
  // API para pessoas já conhecidas.
  const cacheEnabled = String(process.env.DATACRAZY_CACHE_ENABLED ?? '1') !== '0';
  const ttlDays = Math.max(Number(process.env.DATACRAZY_CACHE_TTL_DAYS) || 7, 1);
  const ttlMs = ttlDays * 24 * 60 * 60 * 1000;
  let cacheHits = 0;
  let cacheStaleSkipped = 0;
  if (cacheEnabled && contacts) {
    const cpfList = [];
    const emailList = [];
    for (const c of contacts) {
      const cpf = String(c?.cpf ?? '').replace(/\D/g, '');
      if (cpf.length === 11) cpfList.push(cpf);
      const em = sanitizeContactEmail(c?.email);
      if (em) emailList.push(em);
    }
    const touchList = [];
    const applyCached = (row) => {
      const lastSyncedMs = row.last_synced_at ? new Date(row.last_synced_at).getTime() : 0;
      const allowStale =
        needed.allowStaleCache === true ||
        String(process.env.DATACRAZY_ACTIVATION_USE_STALE_CACHE ?? '1') === '1';
      if (
        !allowStale &&
        lastSyncedMs &&
        Date.now() - lastSyncedMs > ttlMs
      ) {
        cacheStaleSkipped += 1;
        return;
      }
      applyCacheRowToIndex(row, byEmail, byPhone, byCpf, remainingEmails, remainingPhones);
      if (row.cpf) touchList.push(row.cpf);
      cacheHits += 1;
    };
    try {
      if (cpfList.length > 0) {
        const cached = await datacrazyLeadCacheRepo.getByCpfBatch(cpfList);
        for (const [, row] of cached) applyCached(row);
      }
      if (emailList.length > 0) {
        const cachedByEmail = await datacrazyLeadCacheRepo.getByEmailBatch(emailList);
        for (const [, row] of cachedByEmail) applyCached(row);
      }
      if (touchList.length > 0) {
        datacrazyLeadCacheRepo
          .touchLastSeen([...new Set(touchList)])
          .catch((e) => console.warn('[datacrazy-cache] touchLastSeen falhou:', e.message));
      }
      for (let i = personList.length - 1; i >= 0; i--) {
        if (personFoundInIndex(personList[i], byEmail, byPhone, byCpf)) {
          personList.splice(i, 1);
        }
      }
    } catch (e) {
      console.warn('[datacrazy-cache] consulta cache falhou:', e.message);
    }
  }

  // FASE 0.5: histórico de disparos — lead_id já resolvido em ativação anterior.
  let dispatchHistoryHits = 0;
  if (contacts && personList.length > 0) {
    const allKeys = [];
    for (const c of contacts) {
      allKeys.push(
        ...lookupMasterKeysFromParts({
          rgm: c?.rgm,
          cpf: c?.cpf,
          email: c?.email,
          telefone: c?.phone ?? c?.telefone,
        })
      );
    }
    const uniqueKeys = [...new Set(allKeys)];
    if (uniqueKeys.length > 0) {
      try {
        const byKey = await activationDispatchRepo.getSentLeadsByMasterKeys(uniqueKeys);
        const applyDispatchRow = (person, row) => {
          const cpf =
            person.cpf ||
            (row.master_key?.startsWith('CPF:') ? row.master_key.slice(4) : '');
          const lead = {
            id: row.datacrazy_lead_id,
            name: row.nome || person.email || '',
            email: row.email || person.email || '',
            phone: row.telefone || person.phone || '',
            rawPhone: row.telefone || person.phone || '',
            taxId: cpf || undefined,
          };
          mergeLeadIntoMaps(lead, byEmail, byPhone, byCpf);
          dispatchHistoryHits += 1;
        };
        for (const person of personList) {
          if (personFoundInIndex(person, byEmail, byPhone, byCpf)) continue;
          const keys = lookupMasterKeysFromParts(person);
          for (const key of keys) {
            const row = byKey.get(key);
            if (row) {
              applyDispatchRow(person, row);
              break;
            }
          }
        }
        for (let i = personList.length - 1; i >= 0; i--) {
          if (personFoundInIndex(personList[i], byEmail, byPhone, byCpf)) {
            personList.splice(i, 1);
          }
        }
      } catch (e) {
        console.warn('[datacrazy] histórico de disparos falhou:', e.message);
      }
    }
  }

  if (shouldSkipBulkPreflight(personList.length)) {
    sharedLeadsIndex.byEmail = byEmail;
    sharedLeadsIndex.byPhone = byPhone;
    sharedLeadsIndex.byCpf = byCpf;
    sharedLeadsIndex.expires = Date.now() + SHARED_INDEX_TTL_MS;
    const mode = resolveLookupModeLabel();
    return {
      byEmail,
      byPhone,
      byCpf,
      pages: 0,
      leadsScanned: cacheHits,
      direct_search: false,
      lookup_mode: mode,
      direct_queries: 0,
      cpf_direct_queries: 0,
      cpf_direct_hits: 0,
      early_stop: personList.length === 0,
      remaining_emails: remainingEmails.size,
      remaining_phones: remainingPhones.size,
      remaining_persons: personList.length,
      index_reused: useShared,
      cache_hits: cacheHits,
      cache_stale_skipped: cacheStaleSkipped,
      dispatch_history_hits: dispatchHistoryHits,
    };
  }

  // Modo legado bulk_search — varre API em lote (pode gerar 429 em filas grandes).
  const directThreshold = Math.max(
    Number(process.env.DATACRAZY_DIRECT_SEARCH_THRESHOLD) || 5000,
    0
  );
  const { concurrency: directConcurrency, delayMs: directSearchDelayMs } =
    directSearchSettings();

  /** Busca direta por CPF — funciona em lotes grandes onde paginação ignora CPF. */
  const runCpfDirectPass = async () => {
    if (!personList.length) return { queries: 0, hits: 0 };
    const terms = [];
    const seen = new Set();
    for (const person of personList) {
      if (personFoundInIndex(person, byEmail, byPhone, byCpf)) continue;
      if (person.cpf && isValidDatacrazySearchTerm(person.cpf) && !seen.has(person.cpf)) {
        seen.add(person.cpf);
        terms.push(person.cpf);
      }
    }
    let queries = 0;
    let hits = 0;
    await runDirectSearchTerms(terms, (_term, page, rateLimited) => {
      queries += 1;
      if (rateLimited || !page) return;
      for (const lead of page.data) {
        mergeLeadIntoMaps(lead, byEmail, byPhone, byCpf);
        hits += 1;
      }
    });
    return { queries, hits };
  };

  let cpfDirectQueries = 0;
  let cpfDirectHits = 0;
  // Métrica do threshold calculada APÓS FASE 0 — personList já está filtrado
  // pelos hits do cache, representando apenas quem precisa de consulta à API.
  const totalRemaining = personList.length > 0
    ? personList.length
    : Math.max(remainingEmails.size, remainingPhones.size);
  const useDirectSearch = totalRemaining > 0 && totalRemaining <= directThreshold;

  // CPF pass antecipado só na paginação (> threshold). Em busca direta o 2º passe
  // já tenta CPF — evita ~N chamadas duplicadas (ex.: 100 leads = −100 requests).
  if (personList.length > 0 && !useDirectSearch) {
    const cpfPass = await runCpfDirectPass();
    cpfDirectQueries = cpfPass.queries;
    cpfDirectHits = cpfPass.hits;
  }

  let directHits = 0;
  let directQueries = 0;
  let directSkippedInvalid = 0;
  if (useDirectSearch) {
    // Estratégia: 1ª passada consulta 1 termo por pessoa (telefone preferido,
    // email só se sem telefone). 2ª passada cobre quem não foi encontrado,
    // tentando o termo restante (email). Economiza ~50% das chamadas no caso
    // comum, mantendo cobertura quando email/telefone divergem entre nossa
    // base e o CRM.
    const queriedTerms = new Set();
    const runDirectBatch = async (terms) => {
      const validTerms = terms.filter((term) => {
        if (isValidDatacrazySearchTerm(term)) return true;
        directSkippedInvalid += 1;
        return false;
      });
      await runDirectSearchTerms(validTerms, (_term, page, rateLimited) => {
        directQueries += 1;
        if (rateLimited || !page) return;
        for (const lead of page.data) {
          mergeLeadIntoMaps(lead, byEmail, byPhone, byCpf);
          const e = normalizeEmailForMatch(lead.email);
          const p = leadPhoneDigits(lead);
          if (e) remainingEmails.delete(e);
          if (p) remainingPhones.delete(p);
          directHits += 1;
        }
      });
    };

    if (personList.length > 0) {
      // 1ª passada: CPF → telefone → e-mail (rematrícula SIAA: CPF bate melhor no CRM)
      const firstPass = [];
      for (const person of personList) {
        const term = person.cpf || person.phone || person.email;
        if (term && !queriedTerms.has(term)) {
          queriedTerms.add(term);
          firstPass.push(term);
        }
      }
      await runDirectBatch(firstPass);

      // 2ª passada: termos alternativos ainda não consultados
      const secondPass = [];
      for (const person of personList) {
        if (personFoundInIndex(person, byEmail, byPhone, byCpf)) continue;
        for (const term of [person.cpf, person.phone, person.email]) {
          if (term && !queriedTerms.has(term)) {
            queriedTerms.add(term);
            secondPass.push(term);
            break;
          }
        }
      }
      if (secondPass.length > 0) await runDirectBatch(secondPass);
    } else {
      // remanescentes sem dedupe por pessoa.
      const terms = [...remainingPhones, ...remainingEmails];
      await runDirectBatch(terms);
    }

    sharedLeadsIndex.byEmail = byEmail;
    sharedLeadsIndex.byPhone = byPhone;
    sharedLeadsIndex.byCpf = byCpf;
    sharedLeadsIndex.expires = Date.now() + SHARED_INDEX_TTL_MS;

    // FASE 2 (Onda 2): upsert oportunista de leads resolvidos via API no cache
    // pra acelerar próximos disparos. Fire-and-forget — não bloqueia o caller.
    if (cacheEnabled) {
      const upsertList = [];
      const seenId = new Set();
      for (const lead of [...byEmail.values(), ...byPhone.values(), ...byCpf.values()]) {
        if (!lead?.taxId) continue;
        if (seenId.has(lead.id)) continue;
        seenId.add(lead.id);
        upsertList.push(lead);
      }
      if (upsertList.length > 0) {
        datacrazyLeadCacheRepo
          .upsertLeadFromCrmBatch(upsertList, 'preflight')
          .catch((e) => console.warn('[datacrazy-cache] upsert oportunista falhou:', e.message));
      }
    }

    if (directSkippedInvalid > 0) {
      console.warn(
        `[datacrazy] ${directSkippedInvalid} busca(s) ignorada(s) — termo inválido (ex.: placeholder "não encontrado")`
      );
    }

    return {
      byEmail,
      byPhone,
      byCpf,
      pages: 0,
      leadsScanned: directHits + cpfDirectHits,
      lookup_mode: 'bulk_search',
      direct_search: true,
      direct_queries: directQueries + cpfDirectQueries,
      cpf_direct_queries: cpfDirectQueries,
      cpf_direct_hits: cpfDirectHits,
      direct_skipped_invalid: directSkippedInvalid,
      direct_concurrency: directConcurrency,
      direct_search_delay_ms: directSearchDelayMs,
      direct_persons: personList.length,
      early_stop: remainingEmails.size === 0 && remainingPhones.size === 0,
      remaining_emails: remainingEmails.size,
      remaining_phones: remainingPhones.size,
      index_reused: useShared,
      cache_hits: cacheHits,
      cache_stale_skipped: cacheStaleSkipped,
    };
  }

  const take = Math.min(Math.max(Number(process.env.DATACRAZY_LEADS_PAGE_SIZE) || 100, 1), 100);
  const pageDelay = Math.max(Number(process.env.DATACRAZY_PAGE_DELAY_MS) || 400, 0);
  const maxPages = Math.max(Number(process.env.DATACRAZY_MAX_PAGES) || 500, 1);
  let skip = 0;
  let pages = 0;
  let leadsScanned = 0;
  let totalCount = null;

  while (pages < maxPages) {
    const page = await searchLeads({ take, skip, completeAdditionalFields: false });
    pages += 1;
    if (totalCount == null && page.count != null) totalCount = page.count;
    const batch = page.data;
    if (!batch.length) break;
    leadsScanned += batch.length;
    for (const lead of batch) {
      mergeLeadIntoMaps(lead, byEmail, byPhone, byCpf);
      const e = normalizeEmailForMatch(lead.email);
      const p = leadPhoneDigits(lead);
      if (e) remainingEmails.delete(e);
      if (p) remainingPhones.delete(p);
    }
    if (
      remainingEmails.size === 0 &&
      remainingPhones.size === 0 &&
      personList.every((person) => personFoundInIndex(person, byEmail, byPhone, byCpf))
    ) {
      break;
    }
    if (batch.length < take) break;
    if (totalCount != null && skip + batch.length >= totalCount) break;
    skip += batch.length;
    if (pageDelay > 0) await sleep(pageDelay);
  }

  sharedLeadsIndex.byEmail = byEmail;
  sharedLeadsIndex.byPhone = byPhone;
  sharedLeadsIndex.byCpf = byCpf;
  sharedLeadsIndex.expires = Date.now() + SHARED_INDEX_TTL_MS;

  // CPF pass final — quem sobrou após paginação (email/phone no CRM ≠ base).
  if (personList.length > 0) {
    const cpfPass = await runCpfDirectPass();
    cpfDirectQueries += cpfPass.queries;
    cpfDirectHits += cpfPass.hits;
  }

  // FASE 2 (Onda 2): upsert oportunista de leads resolvidos via paginação.
  // Fire-and-forget — não bloqueia o caller.
  if (cacheEnabled) {
    const upsertList = [];
    const seenId = new Set();
    for (const lead of [...byEmail.values(), ...byPhone.values(), ...byCpf.values()]) {
      if (!lead?.taxId) continue;
      if (seenId.has(lead.id)) continue;
      seenId.add(lead.id);
      upsertList.push(lead);
    }
    if (upsertList.length > 0) {
      datacrazyLeadCacheRepo
        .upsertLeadFromCrmBatch(upsertList, 'preflight')
        .catch((e) => console.warn('[datacrazy-cache] upsert oportunista falhou:', e.message));
    }
  }

  return {
    byEmail,
    byPhone,
    byCpf,
    pages,
    leadsScanned: leadsScanned + cpfDirectHits,
    lookup_mode: 'bulk_search',
    direct_search: false,
    cpf_direct_queries: cpfDirectQueries,
    cpf_direct_hits: cpfDirectHits,
    early_stop:
      remainingEmails.size === 0 &&
      remainingPhones.size === 0 &&
      personList.every((person) => personFoundInIndex(person, byEmail, byPhone, byCpf)),
    remaining_emails: remainingEmails.size,
    remaining_phones: remainingPhones.size,
    index_reused: useShared,
    cache_hits: cacheHits,
    cache_stale_skipped: cacheStaleSkipped,
  };
}

function lookupLeadInIndex(index, contact) {
  const cpf = String(contact.cpf ?? '').replace(/\D/g, '');
  if (cpf.length === 11 && index.byCpf?.has(cpf)) return index.byCpf.get(cpf);
  const email = normalizeEmailForMatch(contact.email);
  if (email && index.byEmail.has(email)) return index.byEmail.get(email);
  const phone = normalizePhoneDigits(contact.phone);
  if (phone) {
    if (index.byPhone.has(phone)) return index.byPhone.get(phone);
    for (const [digits, lead] of index.byPhone) {
      if (digits.endsWith(phone) || phone.endsWith(digits)) return lead;
    }
  }
  return null;
}

/**
 * Resolve lead: índice (cache) → busca API serial (CPF → email → tel).
 * @returns {Promise<{ lead: object|null, status: 'found'|'not_found'|'rate_limited' }>}
 */
async function resolveLeadForContact(contact, index, opts = {}) {
  const hit = lookupLeadInIndex(index, contact);
  if (hit) return { lead: hit, status: 'found' };

  const cpfOnly = Boolean(opts.cpfOnly);
  const cpf =
    String(contact.cpf ?? '').replace(/\D/g, '').length === 11
      ? String(contact.cpf ?? '').replace(/\D/g, '')
      : '';
  const email = normalizeEmailForMatch(contact.email);
  const phone = normalizePhoneDigits(contact.phone);
  const terms = cpfOnly
    ? [cpf].filter((t) => t && isValidDatacrazySearchTerm(t))
    : [cpf, email, phone].filter((t) => t && isValidDatacrazySearchTerm(t));
  const seen = new Set();

  const cacheEnabled = String(process.env.DATACRAZY_CACHE_ENABLED ?? '1') !== '0';

  return enqueueLeadResolve(async () => {
    for (const term of terms) {
      if (seen.has(term)) continue;
      seen.add(term);
      const { page, rateLimited } = await searchLeadsDirect(term);
      if (rateLimited) return { lead: null, status: 'rate_limited' };
      const lead = pickLeadFromSearchPage(page, contact);
      if (lead) {
        mergeLeadIntoMaps(lead, index.byEmail, index.byPhone, index.byCpf);
        if (cacheEnabled && lead?.taxId) {
          datacrazyLeadCacheRepo
            .upsertLeadFromCrm(lead, 'resolve')
            .catch((e) => console.warn('[datacrazy-cache] upsert resolve falhou:', e.message));
        }
        return { lead, status: 'found' };
      }
    }
    return { lead: null, status: 'not_found' };
  });
}

export function invalidateSharedLeadsIndex() {
  sharedLeadsIndex.expires = 0;
  sharedLeadsIndex.byEmail.clear();
  sharedLeadsIndex.byPhone.clear();
  sharedLeadsIndex.byCpf.clear();
}

/**
 * Atualiza valor de campo adicional no lead (mesmo endpoint do CRM web).
 * PUT {crm}/api/crm/additional-fields/lead/{leadId}/{fieldDefinitionId}
 * Body: `{ value: "..." }`
 */
async function updateLeadAdditionalField(leadId, fieldDefinitionId, value) {
  const { apiKey } = getConfig();
  const lead = String(leadId ?? '').trim();
  const fieldId = String(fieldDefinitionId ?? '').trim();
  if (!lead) throw new Error('leadId obrigatório');
  if (!fieldId) throw new Error('fieldDefinitionId obrigatório');

  const url = `${getCrmBaseUrl()}/api/crm/additional-fields/lead/${encodeURIComponent(lead)}/${encodeURIComponent(fieldId)}`;
  const response = await datacrazyApiFetch(url, {
    method: 'PUT',
    headers: buildHeaders(apiKey),
    body: JSON.stringify({ value: String(value ?? '') }),
  });
  const text = await response.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = { raw: text };
  }
  if (!response.ok) {
    const message =
      data?.message ||
      data?.error?.message ||
      (Array.isArray(data?.message) ? data.message.join('; ') : null) ||
      data?.raw ||
      `DataCrazy CRM respondeu com status ${response.status}`;
    const error = new Error(message);
    error.status = response.status;
    error.providerResponse = data;
    throw error;
  }
  return data;
}

/**
 * Grava `origem_ativacao` e confirma leitura no lead (GET com additionalFields).
 * Usado no disparo — falha deve interromper a ativação.
 */
async function verifyOrigemAtivacaoForCategory(leadId, category, opts = {}) {
  const skipRead = Boolean(opts.skipRead);
  const expected = origemAtivacaoForCategory(category);
  if (!expected) {
    return { ok: false, skipped: true, reason: 'categoria_sem_mapeamento' };
  }
  if (!ORIGEM_ATIVACAO_FIELD_ID) {
    return {
      ok: false,
      skipped: false,
      error: 'DATACRAZY_ORIGEM_ATIVACAO_FIELD_ID não configurado no .env',
      field: ORIGEM_ATIVACAO_FIELD,
      value: expected,
    };
  }
  // Estratégia:
  // 1) PUT no CRM web -> se 200, consideramos sucesso (a automação do CRM
  //    lê o campo internamente, não via API pública).
  // 2) GET na API pública é só double-check best-effort: se o campo voltar
  //    correto, marcamos verified=true; se não voltar (config "campo não
  //    exposto via API"), seguimos com ok=true, verified=false e warning no log.
  // skipRead=true pula o GET (usado dentro do loop de batch — pré-voo
  // já validou o caminho completo, repetir o GET por pessoa é desperdício).
  try {
    const data = await updateLeadAdditionalField(
      leadId,
      ORIGEM_ATIVACAO_FIELD_ID,
      expected
    );
    const putValue = data?.value ?? expected;

    if (skipRead) {
      return {
        ok: true,
        verified: false,
        field: ORIGEM_ATIVACAO_FIELD,
        value: putValue,
      };
    }

    let lead = null;
    let readErrMsg = null;
    try {
      lead = await getLeadById(leadId);
    } catch (readErr) {
      readErrMsg = readErr.message;
    }
    const read = lead
      ? extractAdditionalFieldValue(lead, ORIGEM_ATIVACAO_FIELD, ORIGEM_ATIVACAO_FIELD_ID)
      : null;

    if (read != null && read.trim() !== '') {
      if (read.trim().toLowerCase() !== expected.trim().toLowerCase()) {
        // PUT respondeu OK mas valor lido diverge - confiamos no PUT mas
        // sinalizamos divergência para diagnóstico.
        console.warn(
          `[origem-ativacao] divergencia lead=${leadId} esperado="${expected}" lido="${read}" - prosseguindo com PUT.`
        );
        return {
          ok: true,
          verified: false,
          warning: `Valor lido "${read}" diverge do esperado "${expected}" (PUT 200 OK; prosseguindo)`,
          field: ORIGEM_ATIVACAO_FIELD,
          value: expected,
        };
      }
      return {
        ok: true,
        verified: true,
        field: ORIGEM_ATIVACAO_FIELD,
        value: read.trim(),
      };
    }

    // PUT 200 OK mas API pública nao retorna o campo (ou nem retornou o lead).
    // A automacao do CRM le internamente, entao seguimos com ok=true.
    const warnReason = readErrMsg
      ? isRateLimitErrorMessage(readErrMsg)
        ? 'rate-limit na leitura (PUT já aplicado)'
        : `nao foi possivel ler o lead (${readErrMsg})`
      : 'API pública não retornou campos adicionais (campo provavelmente sem flag "expor na API")';
    if (!isRateLimitErrorMessage(readErrMsg)) {
      console.warn(
        `[origem-ativacao] PUT OK mas verify-by-read falhou lead=${leadId}: ${warnReason}`
      );
    }
    return {
      ok: true,
      verified: false,
      warning: `PUT no CRM retornou 200 OK; ${warnReason}. Prosseguindo (a automacao do CRM le o campo internamente).`,
      field: ORIGEM_ATIVACAO_FIELD,
      value: putValue,
    };
  } catch (err) {
    // PUT falhou de verdade (status != 200) -> bloqueia
    return {
      ok: false,
      verified: false,
      error: err.message,
      field: ORIGEM_ATIVACAO_FIELD,
      value: expected,
    };
  }
}

/** @deprecated use verifyOrigemAtivacaoForCategory */
async function setOrigemAtivacaoForCategory(leadId, category) {
  return verifyOrigemAtivacaoForCategory(leadId, category);
}

/**
 * Limpa `origem_ativacao` no lead (PUT value=""). Usado pelo job de cleanup
 * pra reverter o campo em leads onde a pessoa nunca respondeu — evita
 * falsos-positivos em respostas tardias (3 meses depois etc.).
 *
 * @param {string} leadId
 * @returns {Promise<{ ok: boolean, error?: string, status?: number }>}
 */
async function clearOrigemAtivacaoForLead(leadId, opts = {}) {
  const skipRead = Boolean(opts.skipRead);
  if (!ORIGEM_ATIVACAO_FIELD_ID) {
    return {
      ok: false,
      error: 'DATACRAZY_ORIGEM_ATIVACAO_FIELD_ID não configurado no .env',
    };
  }
  try {
    await updateLeadAdditionalField(leadId, ORIGEM_ATIVACAO_FIELD_ID, '');
    if (skipRead) return { ok: true };

    let read = null;
    let readErrMsg = null;
    try {
      const lead = await getLeadById(leadId);
      read = lead
        ? extractAdditionalFieldValue(lead, ORIGEM_ATIVACAO_FIELD, ORIGEM_ATIVACAO_FIELD_ID)
        : null;
    } catch (readErr) {
      readErrMsg = readErr.message;
    }

    if (read != null && read.trim() !== '') {
      return {
        ok: false,
        verified: false,
        error: `PUT 200 mas campo ainda preenchido: "${read.trim()}"`,
        field: ORIGEM_ATIVACAO_FIELD,
      };
    }

    if (readErrMsg) {
      if (!isRateLimitErrorMessage(readErrMsg)) {
        console.warn(
          `[origem-ativacao] CLEAR PUT OK mas sem leitura lead=${leadId}: ${readErrMsg}`
        );
      }
    }
    return { ok: true, verified: read != null };
  } catch (err) {
    return {
      ok: false,
      error: err.message,
      status: err.status,
    };
  }
}

/**
 * Cria uma anotação no card do lead no DataCrazy.
 * POST /api/v1/leads/{leadId}/notes body { note }
 * Faz exatamente 1 retentativa em erros de rede (timeout, ECONNRESET, etc.).
 * Erros HTTP (4xx/5xx) NÃO retentam.
 * @param {string} leadId
 * @param {string} note
 * @returns {Promise<{ id: string|null }>}
 */
async function addLeadNote(leadId, note) {
  const { apiKey, baseUrl } = getConfig();
  const url = `${baseUrl}/api/v1/leads/${encodeURIComponent(String(leadId))}/notes`;
  const body = JSON.stringify({ note: String(note ?? '') });

  const response = await datacrazyApiFetch(url, {
    method: 'POST',
    headers: buildHeaders(apiKey),
    body,
  });

  const text = await response.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = { raw: text };
  }

  if (!response.ok) {
    const message =
      data?.message ||
      data?.error?.message ||
      data?.raw ||
      `DataCrazy respondeu com status ${response.status} ao criar anotação`;
    const err = new Error(message);
    err.status = response.status;
    throw err;
  }

  const id =
    data && typeof data === 'object' && 'id' in data && data.id != null ? String(data.id) : null;
  return { id };
}

/** @type {Array<{ leadId: string, note: string, meta: object }>} */
const noteQueue = [];
let noteWorkerActive = false;

async function drainNoteQueue() {
  if (noteWorkerActive) return;
  noteWorkerActive = true;
  while (noteQueue.length > 0) {
    const { leadId, note, meta } = noteQueue.shift();
    try {
      await addLeadNote(leadId, note);
    } catch (err) {
      console.warn('[datacrazy-note] falhou ao criar anotação', {
        leadId,
        ...meta,
        error: err?.message,
      });
    }
  }
  noteWorkerActive = false;
}

/** Enfileira anotação — não bloqueia o loop de envio. */
export function enqueueLeadNote(leadId, note, meta = {}) {
  noteQueue.push({ leadId: String(leadId), note: String(note ?? ''), meta });
  void drainNoteQueue();
}

/**
 * Lê valor de um campo adicional do lead no CRM web.
 * GET {crm}/api/crm/additional-fields/lead/{leadId}/{fieldId}
 * Retorna a string do campo ou null se 404 / campo ausente.
 */
async function getLeadAdditionalFieldValue(leadId, fieldId) {
  const { apiKey } = getConfig();
  const lead = String(leadId ?? '').trim();
  const fId = String(fieldId ?? '').trim();
  if (!lead || !fId) return null;

  const url = `${getCrmBaseUrl()}/api/crm/additional-fields/lead/${encodeURIComponent(lead)}/${encodeURIComponent(fId)}`;
  let response;
  try {
    response = await fetch(url, {
      method: 'GET',
      headers: buildHeaders(apiKey),
    });
  } catch (err) {
    throw new Error(`Falha de rede ao ler campo adicional do CRM: ${err.message}`);
  }

  if (response.status === 404) return null;

  const text = await response.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = { raw: text };
  }

  if (!response.ok) {
    const message =
      data?.message ||
      data?.error?.message ||
      data?.raw ||
      `DataCrazy CRM respondeu com status ${response.status}`;
    const error = new Error(message);
    error.status = response.status;
    throw error;
  }

  // O CRM retorna o objeto com o campo "value"
  if (data && typeof data === 'object' && 'value' in data) {
    return data.value != null ? String(data.value) : null;
  }
  return null;
}

export const datacrazyClient = {
  sendTemplateMessage,
  listTemplates,
  searchLeads,
  getLeadById,
  buildLeadsLookupIndex,
  lookupLeadInIndex,
  resolveLeadForContact,
  invalidateSharedLeadsIndex,
  normalizeEmailForMatch,
  normalizePhoneDigits,
  buildSendTemplatePayload,
  updateLeadAdditionalField,
  getLeadAdditionalFieldValue,
  addLeadNote,
  enqueueLeadNote,
  verifyOrigemAtivacaoForCategory,
  setOrigemAtivacaoForCategory,
  clearOrigemAtivacaoForLead,
  origemAtivacaoForCategory,
  extractAdditionalFieldValue,
};
