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
  const params = new URLSearchParams();
  if (opts.search) params.set('search', String(opts.search).trim());
  const maxTake = Number(process.env.DATACRAZY_LEADS_PAGE_SIZE) || 100;
  params.set('take', String(Math.min(Math.max(opts.take ?? 10, 1), maxTake)));
  params.set('skip', String(Math.max(opts.skip ?? 0, 0)));
  if (opts.completeAdditionalFields === true) {
    params.set('complete[additionalFields]', 'true');
  }
  const url = `${baseUrl}${SEARCH_LEADS_PATH}?${params.toString()}`;
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
  const list = Array.isArray(data?.data) ? data.data : Array.isArray(data) ? data : [];
  return { data: list, count: data?.count ?? list.length };
}

export function normalizeEmailForMatch(v) {
  const s = String(v ?? '').trim().toLowerCase();
  if (s.length < 6 || !s.includes('@')) return '';
  const [local, domain] = s.split('@');
  return local && domain && domain.includes('.') ? s : '';
}

function normalizePhoneDigits(v) {
  let d = String(v ?? '').replace(/\D/g, '');
  if (d.length >= 12 && d.startsWith('55')) d = d.slice(2);
  return d.length >= 10 && d.length <= 11 ? d : '';
}

export function leadPhoneDigits(lead) {
  return String(lead?.rawPhone || lead?.phone || '')
    .replace(/\D/g, '')
    .replace(/^55/, '');
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const SHARED_INDEX_TTL_MS = 20 * 60 * 1000;
const sharedLeadsIndex = { expires: 0, byEmail: new Map(), byPhone: new Map() };

function mergeLeadIntoMaps(lead, byEmail, byPhone) {
  const e = normalizeEmailForMatch(lead.email);
  const p = leadPhoneDigits(lead);
  if (e && !byEmail.has(e)) byEmail.set(e, lead);
  if (p && !byPhone.has(p)) byPhone.set(p, lead);
}

async function buildLeadsLookupIndex(needed = {}) {
  const useShared = sharedLeadsIndex.expires > Date.now();
  const byEmail = useShared ? new Map(sharedLeadsIndex.byEmail) : new Map();
  const byPhone = useShared ? new Map(sharedLeadsIndex.byPhone) : new Map();

  // Normaliza entrada: aceita formato novo `{contacts: [{email, phone}]}` (preferido,
  // permite dedupe por pessoa) e o antigo `{emails, phones}` (sem vínculo).
  // O novo formato evita disparar 2 chamadas (email + telefone) pra mesma pessoa.
  const contacts = Array.isArray(needed.contacts) ? needed.contacts : null;
  const remainingEmails = new Set();
  const remainingPhones = new Set();
  /** @type {Array<{ email: string, phone: string }>} */
  const personList = [];
  if (contacts) {
    const seenKey = new Set();
    for (const c of contacts) {
      const e = normalizeEmailForMatch(c?.email);
      const p = normalizePhoneDigits(c?.phone);
      if (!e && !p) continue;
      // Dedup pessoa por (email|phone) — evita reconsultar mesma pessoa quando
      // a base local tem duplicatas.
      const key = `${e}::${p}`;
      if (seenKey.has(key)) continue;
      seenKey.add(key);
      if (e && !byEmail.has(e)) remainingEmails.add(e);
      if (p && !byPhone.has(p)) remainingPhones.add(p);
      // Se nenhum dos termos ainda precisa busca, pula a pessoa.
      const needsEmail = e && remainingEmails.has(e);
      const needsPhone = p && remainingPhones.has(p);
      if (needsEmail || needsPhone) personList.push({ email: e || '', phone: p || '' });
    }
  } else {
    for (const e of needed.emails || []) {
      if (!byEmail.has(e)) remainingEmails.add(e);
    }
    for (const p of needed.phones || []) {
      if (!byPhone.has(p)) remainingPhones.add(p);
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
          mergeLeadIntoMaps(lead, byEmail, byPhone);
          if (row.email_norm) remainingEmails.delete(row.email_norm);
          if (row.phone_norm) remainingPhones.delete(row.phone_norm);
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
          if (
            (person.email && byEmail.has(person.email)) ||
            (person.phone && byPhone.has(person.phone))
          ) {
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
  // Concorrência paralela das buscas diretas. DataCrazy não publica limite oficial;
  // 10 simultâneas mantém pipeline cheio sem estressar o CRM.
  const directConcurrency = Math.max(
    Math.min(Number(process.env.DATACRAZY_DIRECT_SEARCH_CONCURRENCY) || 10, 20),
    1
  );
  // Métrica do threshold calculada APÓS FASE 0 — personList já está filtrado
  // pelos hits do cache, representando apenas quem precisa de consulta à API.
  const totalRemaining = personList.length > 0
    ? personList.length
    : Math.max(remainingEmails.size, remainingPhones.size);
  let directHits = 0;
  let directQueries = 0;
  if (totalRemaining > 0 && totalRemaining <= directThreshold) {
    // Estratégia: 1ª passada consulta 1 termo por pessoa (telefone preferido,
    // email só se sem telefone). 2ª passada cobre quem não foi encontrado,
    // tentando o termo restante (email). Economiza ~50% das chamadas no caso
    // comum, mantendo cobertura quando email/telefone divergem entre nossa
    // base e o CRM.
    const queriedTerms = new Set();
    const runDirectBatch = async (terms) => {
      for (let i = 0; i < terms.length; i += directConcurrency) {
        const slice = terms.slice(i, i + directConcurrency);
        const results = await Promise.all(
          slice.map(async (term) => {
            try {
              const page = await searchLeads({ search: term, take: 5 });
              return { term, page };
            } catch (err) {
              console.warn(`[datacrazy] direct search "${term}" falhou: ${err.message}`);
              return { term, page: null };
            }
          })
        );
        for (const { page } of results) {
          directQueries += 1;
          if (!page) continue;
          for (const lead of page.data) {
            mergeLeadIntoMaps(lead, byEmail, byPhone);
            const e = normalizeEmailForMatch(lead.email);
            const p = leadPhoneDigits(lead);
            if (e) remainingEmails.delete(e);
            if (p) remainingPhones.delete(p);
            directHits += 1;
          }
        }
      }
    };

    if (personList.length > 0) {
      // 1ª passada: 1 termo por pessoa (prefere telefone)
      const firstPass = [];
      for (const person of personList) {
        const term = person.phone || person.email;
        if (term && !queriedTerms.has(term)) {
          queriedTerms.add(term);
          firstPass.push(term);
        }
      }
      await runDirectBatch(firstPass);

      // 2ª passada: pessoas ainda não encontradas tentam termo alternativo (email)
      const secondPass = [];
      for (const person of personList) {
        const found =
          (person.email && byEmail.has(person.email)) ||
          (person.phone && byPhone.has(person.phone));
        if (found) continue;
        const term = person.email && !queriedTerms.has(person.email) ? person.email : '';
        if (term) {
          queriedTerms.add(term);
          secondPass.push(term);
        }
      }
      if (secondPass.length > 0) await runDirectBatch(secondPass);
    } else {
      // Formato antigo: sem vínculo email↔telefone, consulta todos os termos
      // remanescentes sem dedupe por pessoa.
      const terms = [...remainingPhones, ...remainingEmails];
      await runDirectBatch(terms);
    }

    sharedLeadsIndex.byEmail = byEmail;
    sharedLeadsIndex.byPhone = byPhone;
    sharedLeadsIndex.expires = Date.now() + SHARED_INDEX_TTL_MS;

    // FASE 2 (Onda 2): upsert oportunista de leads resolvidos via API no cache
    // pra acelerar próximos disparos. Fire-and-forget — não bloqueia o caller.
    if (cacheEnabled) {
      const upsertList = [];
      const seenId = new Set();
      for (const lead of [...byEmail.values(), ...byPhone.values()]) {
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
      pages: 0,
      leadsScanned: directHits,
      direct_search: true,
      direct_queries: directQueries,
      direct_concurrency: directConcurrency,
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
      mergeLeadIntoMaps(lead, byEmail, byPhone);
      const e = normalizeEmailForMatch(lead.email);
      const p = leadPhoneDigits(lead);
      if (e) remainingEmails.delete(e);
      if (p) remainingPhones.delete(p);
    }
    if (remainingEmails.size === 0 && remainingPhones.size === 0) break;
    if (batch.length < take) break;
    if (totalCount != null && skip + batch.length >= totalCount) break;
    skip += batch.length;
    if (pageDelay > 0) await sleep(pageDelay);
  }

  sharedLeadsIndex.byEmail = byEmail;
  sharedLeadsIndex.byPhone = byPhone;
  sharedLeadsIndex.expires = Date.now() + SHARED_INDEX_TTL_MS;

  // FASE 2 (Onda 2): upsert oportunista de leads resolvidos via paginação.
  // Fire-and-forget — não bloqueia o caller.
  if (cacheEnabled) {
    const upsertList = [];
    const seenId = new Set();
    for (const lead of [...byEmail.values(), ...byPhone.values()]) {
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
    pages,
    leadsScanned,
    direct_search: false,
    early_stop: remainingEmails.size === 0 && remainingPhones.size === 0,
    remaining_emails: remainingEmails.size,
    remaining_phones: remainingPhones.size,
    index_reused: useShared,
    cache_hits: cacheHits,
    cache_stale_skipped: cacheStaleSkipped,
  };
}

function lookupLeadInIndex(index, contact) {
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
      ? `nao foi possivel ler o lead (${readErrMsg})`
      : 'API pública não retornou campos adicionais (campo provavelmente sem flag "expor na API")';
    console.warn(
      `[origem-ativacao] PUT OK mas verify-by-read falhou lead=${leadId}: ${warnReason}`
    );
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
      console.warn(
        `[origem-ativacao] CLEAR PUT OK mas sem leitura lead=${leadId}: ${readErrMsg}`
      );
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
