/**
 * Fonte de sync do espelho local via HTTP API do CRM EduIT
 * (quando o Postgres local não é a org de produção).
 */
import {
  getDeal,
  isNovoCrmApiConfigured,
  listContactsPage,
  listDealsPage,
} from '../services/novoCrmClient.js';
import {
  collectFilledBusinessPaths,
  hashObject,
  normalizeCpf,
  normalizeEmail,
  normalizePhone,
  normalizeRgm,
} from '../utils/novoCrmCacheNormalize.js';

function toIso(value) {
  return value ? new Date(value).toISOString() : null;
}

function pickPrimaryDeal(deals) {
  if (!deals.length) return null;
  const sorted = deals.slice().sort((a, b) => {
    const ao = String(a.status || '').toUpperCase() === 'OPEN' ? 1 : 0;
    const bo = String(b.status || '').toUpperCase() === 'OPEN' ? 1 : 0;
    if (ao !== bo) return bo - ao;
    return String(b.updatedAt || b.createdAt || '').localeCompare(
      String(a.updatedAt || a.createdAt || '')
    );
  });
  return sorted[0] || null;
}

function maxDate(values) {
  const dates = values.filter(Boolean).map((v) => new Date(v).getTime()).filter(Number.isFinite);
  if (!dates.length) return null;
  return new Date(Math.max(...dates)).toISOString();
}

function panelFieldsToCustom(fields) {
  if (!Array.isArray(fields)) return [];
  return fields.map((f) => ({
    id: f.fieldId ? String(f.fieldId) : f.id ? String(f.id) : null,
    name: String(f.name || '').trim(),
    value:
      f.value == null || String(f.value).trim() === ''
        ? null
        : typeof f.value === 'object'
          ? f.value?.value != null
            ? String(f.value.value)
            : null
          : String(f.value),
  }));
}

function findCustomValue(customFields, wantedNames) {
  const wanted = wantedNames.map((v) => String(v).trim().toLowerCase());
  for (const field of customFields || []) {
    const name = String(field.name || '')
      .trim()
      .toLowerCase();
    if (wanted.includes(name) && field.value != null && String(field.value).trim() !== '') {
      return field.value;
    }
  }
  return null;
}

/**
 * @param {object} contact — item da listagem ou GET contact
 * @param {object[]} dealSummaries — deals da listagem
 * @param {Map<string, object>} [dealDetailsById] — GET /deals/:id (com dealPanelFields)
 */
export function mapApiSnapshot(contact, dealSummaries = [], dealDetailsById = new Map()) {
  const deals = (dealSummaries || []).map((d) => {
    const detail = dealDetailsById.get(String(d.id));
    const customFields = panelFieldsToCustom(detail?.dealPanelFields);
    return {
      id: String(d.id),
      number: d.number != null ? String(d.number) : null,
      title: d.title || null,
      status: d.status != null ? String(d.status) : null,
      ownerId: d.ownerId || null,
      ownerName: d.owner?.name || null,
      ownerEmail: d.owner?.email || null,
      createdAt: toIso(d.createdAt),
      updatedAt: toIso(d.updatedAt),
      customFields,
      // Listagem não traz tags; o GET do deal primário traz. Persistir no
      // espelho permite ao dry-run reconhecer a quarentena do dedupe.
      tags: Array.isArray(detail?.tags) ? detail.tags : [],
      stageId: d.stageId || detail?.stageId || null,
      stageName: d.stage?.name || detail?.stage?.name || null,
    };
  });

  const primaryDeal = pickPrimaryDeal(deals);
  const ordered = primaryDeal
    ? [primaryDeal, ...deals.filter((d) => d.id !== primaryDeal.id)]
    : deals;
  let cpf = null;
  let rgm = null;
  for (const deal of ordered) {
    if (!cpf) cpf = findCustomValue(deal.customFields, ['cpf', 'documento', 'taxid']);
    if (!rgm) rgm = findCustomValue(deal.customFields, ['rgm']);
    if (cpf && rgm) break;
  }

  const phone = contact.phone || null;
  const email = contact.email || null;
  const rawData = {
    contact: {
      id: String(contact.id),
      number: contact.number != null ? String(contact.number) : null,
      name: contact.name || null,
      email,
      phone,
      assignedToId: contact.assignedToId || null,
      assignedName: null,
      assignedEmail: null,
      createdAt: toIso(contact.createdAt),
      updatedAt: toIso(contact.updatedAt),
    },
    primaryDealId: primaryDeal?.id || null,
    dealsById: Object.fromEntries(deals.map((d) => [String(d.id), d])),
    source: 'api',
  };

  const filled = collectFilledBusinessPaths(rawData);
  const sourceUpdatedAt = maxDate([
    contact.updatedAt,
    contact.createdAt,
    ...deals.flatMap((d) => [d.updatedAt, d.createdAt]),
  ]);

  return {
    contactId: String(contact.id),
    primaryDealId: primaryDeal?.id || null,
    contactNumber: contact.number != null ? String(contact.number) : null,
    nome: contact.name || null,
    phoneNorm: normalizePhone(phone) || null,
    emailNorm: normalizeEmail(email) || null,
    cpfNorm: normalizeCpf(cpf) || null,
    rgmNorm: normalizeRgm(rgm) || null,
    rawData,
    filledFieldCount: filled.size,
    contentHash: hashObject(rawData),
    sourceUpdatedAt,
  };
}

export function assertApiSourceReady() {
  if (!isNovoCrmApiConfigured()) {
    const err = new Error(
      'Novo CRM API não configurada. Defina NOVO_CRM_ENABLED=1 e NOVO_CRM_API_TOKEN.'
    );
    err.status = 503;
    throw err;
  }
}

export async function countAllContactsViaApi() {
  assertApiSourceReady();
  const page = await listContactsPage({ page: 1, perPage: 1 });
  return page.total;
}

/**
 * Carrega todos os deals da API indexados por contactId.
 *
 * Paginação por offset com ordenação instável: itens migram de página enquanto
 * o sync roda, então uma página curta no meio NÃO significa fim (parar ali
 * deixava contacts sem deal no espelho — falsos órfãos). Só encerra quando a
 * página vem vazia ou `totalPages` é atingido; deduplica por id.
 *
 * @param {{ onProgress?: (p: {page:number,totalPages:number|null,seen:number,total:number}) => void, delayMs?: number, maxPages?: number }} [opts]
 */
export async function loadAllDealsByContactId(opts = {}) {
  assertApiSourceReady();
  const delayMs = Math.max(Number(opts.delayMs) || 80, 0);
  const maxPages = Math.min(Math.max(Number(opts.maxPages) || 5000, 1), 20000);
  /** @type {Map<string, object[]>} */
  const byContact = new Map();
  /** @type {Map<string, string>} */
  const dealToContact = new Map();
  let page = 1;
  let totalPages = null;
  let total = 0;
  let seen = 0;

  while (page <= maxPages) {
    const res = await listDealsPage({ page, perPage: 100 });
    total = res.total;
    totalPages = res.totalPages || Math.ceil(total / 100) || null;
    for (const d of res.items) {
      const did = d?.id ? String(d.id) : '';
      const cid = d?.contactId ? String(d.contactId) : '';
      if (!did || !cid || dealToContact.has(did)) continue;
      dealToContact.set(did, cid);
      seen += 1;
      const arr = byContact.get(cid) || [];
      arr.push(d);
      byContact.set(cid, arr);
    }
    opts.onProgress?.({ page, totalPages, seen, total });
    if (!res.items.length) break;
    if (totalPages != null && page >= totalPages) break;
    page += 1;
    if (delayMs) await new Promise((r) => setTimeout(r, delayMs));
  }

  if (total && seen < total) {
    console.warn(
      `[novo-crm-api-source] índice de deals incompleto: ${seen}/${total} (deriva de paginação) — verificação por contact cobre o restante`
    );
  }
  return byContact;
}

/**
 * @param {{ page: number, perPage?: number }} opts
 */
export async function listContactsApiPage(opts) {
  assertApiSourceReady();
  return listContactsPage({
    page: opts.page,
    perPage: opts.perPage || 200,
  });
}

/**
 * Busca dealPanelFields dos primary deals (concorrência limitada).
 * @param {string[]} dealIds
 * @param {{ concurrency?: number, delayMs?: number }} [opts]
 */
export async function fetchDealDetailsByIds(dealIds, opts = {}) {
  // Conservador: o teto global em novoCrmClient (NOVO_CRM_API_RATE_PER_SECOND) já limita.
  const concurrency = Math.min(Math.max(Number(opts.concurrency) || 2, 1), 6);
  const delayMs = Math.max(Number(opts.delayMs) || 150, 0);
  /** @type {Map<string, object>} */
  const out = new Map();
  const ids = [...new Set(dealIds.filter(Boolean).map(String))];

  for (let i = 0; i < ids.length; i += concurrency) {
    const chunk = ids.slice(i, i + concurrency);
    const results = await Promise.all(
      chunk.map(async (id) => {
        try {
          const d = await getDeal(id);
          return [id, d];
        } catch {
          return [id, null];
        }
      })
    );
    for (const [id, d] of results) {
      if (d) out.set(id, d);
    }
    if (delayMs && i + concurrency < ids.length) {
      await new Promise((r) => setTimeout(r, delayMs));
    }
  }
  return out;
}

export function shouldFetchDealFields() {
  const v = String(process.env.NOVO_CRM_CACHE_FETCH_DEAL_FIELDS || '1').trim();
  return v !== '0' && v.toLowerCase() !== 'false';
}

/**
 * Deals de um contact (amostra / sync parcial — evita indexar a org inteira).
 * @param {string} contactId
 */
export async function listDealsForContactId(contactId) {
  assertApiSourceReady();
  const id = String(contactId || '').trim();
  if (!id) return [];
  const res = await listDealsPage({ page: 1, perPage: 100, contactId: id });
  return res.items || [];
}
