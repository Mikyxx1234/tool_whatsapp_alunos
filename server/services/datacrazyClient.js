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
import { datacrazyCrmLimiter } from '../utils/datacrazyCrmLimiter.js';
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
  const response = await fetch(url, { method: 'GET', headers: buildHeaders(apiKey) });
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

function isRateLimitErrorMessage(msg) {
  const s = String(msg ?? '').toLowerCase();
  return s.includes('too many requests') || s.includes('rate limit') || s.includes('429');
}

function directSearchSettings() {
  return {
    concurrency: Math.max(
      Math.min(Number(process.env.DATACRAZY_DIRECT_SEARCH_CONCURRENCY) || 4, 15),
      1
    ),
    delayMs: Math.max(Number(process.env.DATACRAZY_DIRECT_SEARCH_DELAY_MS) || 0, 0),
    cooldownMs: Math.max(Number(process.env.DATACRAZY_RATE_LIMIT_COOLDOWN_MS) || 1500, 300),
  };
}

/** Pausa compartilhada só quando a API retorna 429 (não entre todo lote). */
let directSearchCooldownUntil = 0;

/** Busca direta — retry único após cooldown adaptativo em 429. */
async function searchLeadsDirect(term) {
  const { cooldownMs } = directSearchSettings();
  const now = Date.now();
  if (now < directSearchCooldownUntil) {
    await sleep(directSearchCooldownUntil - now);
  }
  try {
    return await searchLeads({ search: term, take: 5 });
  } catch (err) {
    const rateLimited = err.status === 429 || isRateLimitErrorMessage(err.message);
    if (rateLimited) {
      directSearchCooldownUntil = Date.now() + cooldownMs;
      await sleep(cooldownMs);
      try {
        return await searchLeads({ search: term, take: 5 });
      } catch (retryErr) {
        console.warn(`[datacrazy] direct search "${term}" falhou: ${retryErr.message}`);
        return null;
      }
    }
    console.warn(`[datacrazy] direct search "${term}" falhou: ${err.message}`);
    return null;
  }
}

/**
 * Executa buscas diretas com concorrência baixa + pausa entre lotes.
 * @param {string[]} terms
 * @param {(term: string, page: { data: object[] }|null) => void} onResult
 */
async function runDirectSearchTerms(terms, onResult) {
  const { concurrency, delayMs } = directSearchSettings();
  for (let i = 0; i < terms.length; i += concurrency) {
    const slice = terms.slice(i, i + concurrency);
    const pages = await Promise.all(slice.map((term) => searchLeadsDirect(term)));
    for (let j = 0; j < slice.length; j++) {
      onResult(slice[j], pages[j]);
    }
    if (i + concurrency < terms.length && delayMs > 0) {
      await sleep(delayMs);
    }
  }
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
  /** @type {Array<{ email: string, phone: string, cpf: string }>} */
  const personList = [];
  if (contacts) {
    const seenKey = new Set();
    for (const c of contacts) {
      const e = sanitizeContactEmail(c?.email);
      const p = sanitizeContactPhone(c?.phone);
      const cpfDigits = String(c?.cpf ?? '').replace(/\D/g, '');
      const cpf = cpfDigits.length === 11 ? cpfDigits : '';
      if (!e && !p && !cpf) continue;
      const key = `${e}::${p}::${cpf}`;
      if (seenKey.has(key)) continue;
      seenKey.add(key);
      if (e && !byEmail.has(e)) remainingEmails.add(e);
      if (p && !byPhone.has(p)) remainingPhones.add(p);
      if ((e && byEmail.has(e)) || (p && byPhone.has(p)) || (cpf && byCpf.has(cpf))) continue;
      personList.push({ email: e || '', phone: p || '', cpf: cpf || '' });
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
    for (const c of contacts) {
      const cpf = String(c?.cpf ?? '').replace(/\D/g, '');
      if (cpf.length === 11) cpfList.push(cpf);
    }
    if (cpfList.length > 0) {
      try {
        const cached = await datacrazyLeadCacheRepo.getByCpfBatch(cpfList);
        const touchList = [];
        for (const [cpf, row] of cached) {
          const lastSyncedMs = row.last_synced_at
            ? new Date(row.last_synced_at).getTime()
            : 0;
          if (lastSyncedMs && Date.now() - lastSyncedMs > ttlMs) {
            cacheStaleSkipped += 1;
            continue;
          }
          const lead = row.raw_lead || {
            id: row.datacrazy_lead_id,
            email: row.email_norm,
            rawPhone: row.phone_norm,
            name: row.nome,
          };
          mergeLeadIntoMaps(lead, byEmail, byPhone, byCpf);
          if (row.email_norm) remainingEmails.delete(row.email_norm);
          if (row.phone_norm) remainingPhones.delete(row.phone_norm);
          if (cpf.length === 11 && !byCpf.has(cpf)) byCpf.set(cpf, lead);
          touchList.push(cpf);
          cacheHits += 1;
        }
        if (touchList.length > 0) {
          datacrazyLeadCacheRepo
            .touchLastSeen(touchList)
            .catch((e) => console.warn('[datacrazy-cache] touchLastSeen falhou:', e.message));
        }
        // Remove pessoas já resolvidas pelo cache de personList
        for (let i = personList.length - 1; i >= 0; i--) {
          const person = personList[i];
          if (personFoundInIndex(person, byEmail, byPhone, byCpf)) {
            personList.splice(i, 1);
          }
        }
      } catch (e) {
        console.warn('[datacrazy-cache] consulta cache falhou:', e.message);
      }
    }
  }

  // Atalho: para lotes pequenos (<= threshold), usa busca direta da API
  // (`?search=<termo>`) em vez de varrer centenas de páginas. Reduz de minutos
  // pra segundos quando o disparo é de poucas pessoas.
  // Threshold passou a representar "pessoas" (não "termos"). Default 250 cobre
  // a maior parte dos disparos manuais; acima disso a paginação completa
  // (1 página resolve ~100 pessoas) fica mais eficiente em volume.
  const directThreshold = Math.max(
    Number(process.env.DATACRAZY_DIRECT_SEARCH_THRESHOLD) || 250,
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
    await runDirectSearchTerms(terms, (_term, page) => {
      queries += 1;
      if (!page) return;
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
      await runDirectSearchTerms(validTerms, (_term, page) => {
        directQueries += 1;
        if (!page) return;
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
      // 1ª passada: telefone → CPF → e-mail (CPF costuma bater melhor no SIAA/Kommo)
      const firstPass = [];
      for (const person of personList) {
        const term = person.phone || person.cpf || person.email;
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
        for (const term of [person.phone, person.cpf, person.email]) {
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
  const response = await fetch(url, {
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

  async function attempt() {
    let response;
    try {
      response = await fetch(url, {
        method: 'POST',
        headers: buildHeaders(apiKey),
        body,
      });
    } catch (err) {
      const e = new Error(`Falha de rede ao criar anotação no DataCrazy: ${err.message}`);
      e.cause = err;
      e.isNetworkError = true;
      throw e;
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
        data?.message ||
        data?.error?.message ||
        data?.raw ||
        `DataCrazy respondeu com status ${response.status} ao criar anotação`;
      const err = new Error(message);
      err.status = response.status;
      throw err;
    }

    const id =
      (data && typeof data === 'object' && 'id' in data && data.id != null)
        ? String(data.id)
        : null;
    return { id };
  }

  try {
    return await attempt();
  } catch (err) {
    if (err.isNetworkError) {
      return await attempt();
    }
    throw err;
  }
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
  invalidateSharedLeadsIndex,
  normalizeEmailForMatch,
  normalizePhoneDigits,
  buildSendTemplatePayload,
  updateLeadAdditionalField,
  getLeadAdditionalFieldValue,
  addLeadNote,
  verifyOrigemAtivacaoForCategory,
  setOrigemAtivacaoForCategory,
  clearOrigemAtivacaoForLead,
  origemAtivacaoForCategory,
  extractAdditionalFieldValue,
};
