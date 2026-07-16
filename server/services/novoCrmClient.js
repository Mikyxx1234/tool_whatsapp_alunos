/**
 * Cliente HTTP do CRM EduIT (Novo CRM).
 *
 * Env:
 *   NOVO_CRM_API_BASE_URL=https://crm.eduit.com.br
 *   NOVO_CRM_API_TOKEN=eduit_...
 *   NOVO_CRM_ENABLED=1
 */

import { tagNameForCategory } from '../utils/novoCrmActivationTags.js';
import * as tagLogRepo from '../repositories/activationNovoCrmTagRepository.js';

function apiBase() {
  return String(process.env.NOVO_CRM_API_BASE_URL || 'https://crm.eduit.com.br')
    .trim()
    .replace(/\/$/, '');
}

function apiToken() {
  return String(process.env.NOVO_CRM_API_TOKEN || '').trim();
}

export function isNovoCrmApiConfigured() {
  const enabled = String(process.env.NOVO_CRM_ENABLED || '').trim() === '1';
  return enabled && Boolean(apiToken());
}

function digitsOnly(v) {
  return String(v ?? '').replace(/\D/g, '');
}

function phoneSearchVariants(telefone) {
  let d = digitsOnly(telefone);
  if (!d) return [];
  if (d.length >= 12 && d.startsWith('55')) d = d.slice(2);
  const out = new Set();
  if (d.length >= 10) {
    out.add(d);
    out.add(`55${d}`);
    out.add(`+55${d}`);
  }
  return [...out];
}

/**
 * @param {string} path
 * @param {{ method?: string, body?: unknown }} [opts]
 */
async function request(path, opts = {}) {
  const token = apiToken();
  if (!token) {
    const err = new Error('NOVO_CRM_API_TOKEN não configurado.');
    err.status = 503;
    throw err;
  }
  const method = opts.method || 'GET';
  const res = await fetch(`${apiBase()}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/json',
      ...(opts.body != null ? { 'Content-Type': 'application/json' } : {}),
    },
    body: opts.body != null ? JSON.stringify(opts.body) : undefined,
  });
  const text = await res.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = { raw: text };
  }
  if (!res.ok) {
    const err = new Error(json?.message || json?.error || `Novo CRM HTTP ${res.status}`);
    err.status = res.status;
    err.body = json;
    throw err;
  }
  return json;
}

function normalizeTagBody(tag) {
  const tagId = tag?.tagId ? String(tag.tagId).trim() : '';
  const tagName = tag?.tagName ? String(tag.tagName).trim() : '';
  if (!tagId && !tagName) {
    const err = new Error('tagId ou tagName obrigatório');
    err.status = 400;
    throw err;
  }
  return tagId ? { tagId } : { tagName };
}

function itemsFromListResponse(raw) {
  if (Array.isArray(raw)) return raw;
  if (Array.isArray(raw?.items)) return raw.items;
  return [];
}

/**
 * Busca contact por telefone / CPF / e-mail (nessa ordem).
 * @param {{ telefone?: string|null, cpf?: string|null, email?: string|null, nome?: string|null }} item
 * @returns {Promise<object|null>}
 */
export async function searchContactForActivationItem(item) {
  const tried = new Set();
  const queries = [
    ...phoneSearchVariants(item?.telefone),
    (() => {
      const cpf = digitsOnly(item?.cpf);
      return cpf.length === 11 ? cpf : '';
    })(),
    String(item?.email || '')
      .trim()
      .toLowerCase(),
  ].filter((q) => q && q.length >= 3);

  for (const q of queries) {
    if (tried.has(q)) continue;
    tried.add(q);
    const raw = await request(`/api/contacts?search=${encodeURIComponent(q)}`);
    const items = itemsFromListResponse(raw);
    if (items.length === 0) continue;

    const phoneWanted = phoneSearchVariants(item?.telefone);
    const cpfWanted = digitsOnly(item?.cpf);
    const emailWanted = String(item?.email || '')
      .trim()
      .toLowerCase();

    const ranked = items.slice().sort((a, b) => {
      const score = (c) => {
        let s = 0;
        const p = digitsOnly(c.phone);
        const pNorm = p.length >= 12 && p.startsWith('55') ? p.slice(2) : p;
        if (phoneWanted.some((v) => digitsOnly(v).endsWith(pNorm) || pNorm.endsWith(digitsOnly(v).slice(-11)))) {
          s += 10;
        }
        if (cpfWanted.length === 11 && String(c.email || '').includes(cpfWanted)) s += 3;
        if (emailWanted && String(c.email || '').toLowerCase() === emailWanted) s += 8;
        return s;
      };
      return score(b) - score(a);
    });
    return ranked[0] || null;
  }
  return null;
}

/**
 * Deal OPEN do contact (primeiro), senão qualquer deal.
 * @param {string} contactId
 * @returns {Promise<object|null>}
 */
export async function findDealForContact(contactId) {
  const id = String(contactId || '').trim();
  if (!id) return null;
  const raw = await request(`/api/deals?contactId=${encodeURIComponent(id)}`);
  const items = itemsFromListResponse(raw);
  if (items.length === 0) return null;
  const open = items.find((d) => String(d.status || '').toUpperCase() === 'OPEN');
  return open || items[0];
}

/**
 * @param {{ telefone?: string|null, cpf?: string|null, email?: string|null, nome?: string|null }} item
 * @returns {Promise<{ contactId: string, dealId: string|null, contact: object, deal: object|null }|null>}
 */
export async function resolveContactAndDealForActivationItem(item) {
  const contact = await searchContactForActivationItem(item);
  if (!contact?.id) return null;
  const deal = await findDealForContact(contact.id);
  return {
    contactId: String(contact.id),
    dealId: deal?.id ? String(deal.id) : null,
    contact,
    deal,
  };
}

/** Lista tags da org autenticada. @returns {Promise<Array<{id:string,name:string,color?:string}>>} */
export async function listTags() {
  const raw = await request('/api/tags');
  return Array.isArray(raw) ? raw : [];
}

/**
 * Resolve tagId pelo nome (após POST que pode ter criado a tag).
 * @param {string} tagName
 * @returns {Promise<string|null>}
 */
export async function resolveTagIdByName(tagName) {
  const name = String(tagName || '').trim();
  if (!name) return null;
  const tags = await listTags();
  const hit = tags.find((t) => String(t?.name || '') === name);
  return hit?.id ? String(hit.id) : null;
}

/**
 * @param {string} dealId
 * @param {{ tagId?: string, tagName?: string }} tag
 */
export async function addTagToDeal(dealId, tag) {
  const id = String(dealId || '').trim();
  if (!id) {
    const err = new Error('dealId obrigatório');
    err.status = 400;
    throw err;
  }
  return request(`/api/deals/${encodeURIComponent(id)}/tags`, {
    method: 'POST',
    body: normalizeTagBody(tag),
  });
}

/**
 * @param {string} contactId
 * @param {{ tagId?: string, tagName?: string }} tag
 */
export async function addTagToContact(contactId, tag) {
  const id = String(contactId || '').trim();
  if (!id) {
    const err = new Error('contactId obrigatório');
    err.status = 400;
    throw err;
  }
  return request(`/api/contacts/${encodeURIComponent(id)}/tags`, {
    method: 'POST',
    body: normalizeTagBody(tag),
  });
}

/**
 * @param {string} dealId
 * @param {{ tagId?: string, tagName?: string }} tag
 * DELETE no CRM exige tagId (tagName só funciona no POST).
 */
export async function removeTagFromDeal(dealId, tag) {
  const id = String(dealId || '').trim();
  if (!id) {
    const err = new Error('dealId obrigatório');
    err.status = 400;
    throw err;
  }
  let tagId = tag?.tagId ? String(tag.tagId).trim() : '';
  if (!tagId && tag?.tagName) {
    tagId = (await resolveTagIdByName(String(tag.tagName).trim())) || '';
  }
  if (!tagId) {
    const err = new Error('tagId obrigatório para remover tag (DELETE)');
    err.status = 400;
    throw err;
  }
  return request(`/api/deals/${encodeURIComponent(id)}/tags`, {
    method: 'DELETE',
    body: { tagId },
  });
}

/**
 * @param {string} contactId
 * @param {{ tagId?: string, tagName?: string }} tag
 * DELETE no CRM exige tagId (tagName só funciona no POST).
 */
export async function removeTagFromContact(contactId, tag) {
  const id = String(contactId || '').trim();
  if (!id) {
    const err = new Error('contactId obrigatório');
    err.status = 400;
    throw err;
  }
  let tagId = tag?.tagId ? String(tag.tagId).trim() : '';
  if (!tagId && tag?.tagName) {
    tagId = (await resolveTagIdByName(String(tag.tagName).trim())) || '';
  }
  if (!tagId) {
    const err = new Error('tagId obrigatório para remover tag (DELETE)');
    err.status = 400;
    throw err;
  }
  return request(`/api/contacts/${encodeURIComponent(id)}/tags`, {
    method: 'DELETE',
    body: { tagId },
  });
}

/**
 * Aplica tag canônica da categoria no contact (+ deal se informado) e grava log SET.
 *
 * @param {{
 *   contactId: string,
 *   dealId?: string|null,
 *   category: string,
 *   masterKey?: string|null,
 *   cpf?: string|null,
 *   rgm?: string|null,
 *   nome?: string|null,
 * }} opts
 */
export async function activateByCategoryTag(opts) {
  const contactId = String(opts?.contactId || '').trim();
  const category = String(opts?.category || '').trim();
  const dealId = opts?.dealId ? String(opts.dealId).trim() : null;
  if (!contactId) {
    const err = new Error('contactId obrigatório');
    err.status = 400;
    throw err;
  }
  const tagName = tagNameForCategory(category);
  if (!tagName) {
    const err = new Error(`Categoria sem tag de ativação: ${category}`);
    err.status = 400;
    throw err;
  }

  const logBase = {
    category,
    tagName,
    contactId,
    dealId,
    masterKey: opts?.masterKey ?? null,
    cpf: opts?.cpf ?? null,
    rgm: opts?.rgm ?? null,
    nome: opts?.nome ?? null,
  };

  try {
    await addTagToContact(contactId, { tagName });
    if (dealId) {
      await addTagToDeal(dealId, { tagName });
    }
    const tagId = await resolveTagIdByName(tagName);
    await tagLogRepo.recordTagLog({
      ...logBase,
      tagId,
      tagValue: tagName,
      status: 'ok',
    });
    return { ok: true, tagName, tagId, contactId, dealId };
  } catch (err) {
    await tagLogRepo
      .recordTagLog({
        ...logBase,
        tagId: null,
        tagValue: tagName,
        status: 'failed',
        errorMessage: err?.message || String(err),
      })
      .catch(() => {});
    throw err;
  }
}

/**
 * @param {string} dealId
 * @param {string} category
 * @deprecated Prefer activateByCategoryTag com contactId (UI mostra tags no contact).
 */
export async function activateDealByCategoryTag(dealId, category) {
  const tagName = tagNameForCategory(category);
  if (!tagName) {
    const err = new Error(`Categoria sem tag de ativação: ${category}`);
    err.status = 400;
    throw err;
  }
  return addTagToDeal(dealId, { tagName });
}

export { tagNameForCategory, ATIVACAO_TAG_BY_CATEGORY } from '../utils/novoCrmActivationTags.js';
