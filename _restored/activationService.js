import * as baseUploadRepo from '../repositories/baseUploadRepository.js';
import { collectRowIdentities } from './baseComparisonService.js';
import { datacrazyClient } from './datacrazyClient.js';

const ACTIVATION_CACHE_TTL_MS = 10 * 60 * 1000;
/** @type {{ key: string, expires: number, data: object } | null} */
let activationListCache = null;

/** @param {Set<string>} ids */
function canonicalFromIdentities(ids) {
  const list = [...ids];
  const rgms = list.filter((x) => x.startsWith('RGM:')).sort();
  const cpfs = list.filter((x) => x.startsWith('CPF:')).sort();
  const emails = list.filter((x) => x.startsWith('EMAIL:')).sort();
  const tels = list.filter((x) => x.startsWith('TEL:')).sort();
  if (rgms.length) return rgms[0];
  if (cpfs.length) return cpfs[0];
  if (emails.length) return emails[0];
  if (tels.length) return tels[0];
  return null;
}

/**
 * @param {string} category
 * @param {string} snapshotId
 */
async function buildPersonIndexWithSampleRow(category, snapshotId) {
  /** @type {Map<string, { ids: Set<string>, row: Record<string, unknown> }>} */
  const byCanon = new Map();
  let skipped = 0;
  let rowCount = 0;
  await baseUploadRepo.forEachRowDataForSnapshot(category, snapshotId, (row) => {
    rowCount += 1;
    const ids = collectRowIdentities(row);
    if (ids.size === 0) {
      skipped += 1;
      return;
    }
    const canon = canonicalFromIdentities(ids);
    if (!canon) {
      skipped += 1;
      return;
    }
    const cur = byCanon.get(canon);
    if (!cur) {
      byCanon.set(canon, { ids: new Set(ids), row });
    } else {
      for (const id of ids) cur.ids.add(id);
    }
  });
  return { byCanon, skipped, rowCount };
}

/** @param {Map<string, { ids: Set<string> }>} byCanon */
function unionIdentitySet(byCanon) {
  /** @type {Set<string>} */
  const u = new Set();
  for (const { ids } of byCanon.values()) {
    for (const id of ids) u.add(id);
  }
  return u;
}

/** @param {Record<string, unknown>} row */
function rowToActivationItem(row) {
  return {
    nome: String(row.Nome ?? row.Aluno ?? '').trim(),
    email: String(row.Email ?? '').trim(),
    telefone: String(row['Fone celular'] ?? row.Celular ?? row.Telefone ?? '').trim(),
    rgm: String(row.RGM ?? '').trim(),
    cpf: String(row.CPF ?? '').trim(),
    polo: String(row.Polo ?? '').trim(),
    curso: String(row.Curso ?? '').trim(),
    ciclo: String(row.Ciclo ?? '').trim(),
    situacao_matricula: String(row['Situação Matrícula'] ?? row.Situacao ?? '').trim(),
  };
}

/**
 * Matriculados que também estão na base de docs pendentes (lista de ativação).
 */
export async function getDocsPendentesActivationList() {
  const matSnap = await baseUploadRepo.getLatestSnapshot('matriculados');
  const docsSnap = await baseUploadRepo.getLatestSnapshot('docs-pendentes');
  if (!matSnap) {
    const err = new Error('Nenhum snapshot de matriculados.');
    err.status = 404;
    throw err;
  }
  if (!docsSnap) {
    const err = new Error('Nenhum snapshot de documentos pendentes.');
    err.status = 404;
    throw err;
  }

  const cacheKey = `${matSnap.id}:${docsSnap.id}`;
  if (
    activationListCache &&
    activationListCache.key === cacheKey &&
    activationListCache.expires > Date.now()
  ) {
    return activationListCache.data;
  }

  const [matIndex, docsIndex] = await Promise.all([
    buildPersonIndexWithSampleRow('matriculados', matSnap.id),
    buildPersonIndexWithSampleRow('docs-pendentes', docsSnap.id),
  ]);

  const docsUnion = unionIdentitySet(docsIndex.byCanon);
  /** @type {ReturnType<typeof rowToActivationItem>[]} */
  const items = [];

  for (const { ids, row } of matIndex.byCanon.values()) {
    let hit = false;
    for (const id of ids) {
      if (docsUnion.has(id)) {
        hit = true;
        break;
      }
    }
    if (hit) items.push(rowToActivationItem(row));
  }

  items.sort((a, b) => a.nome.localeCompare(b.nome, 'pt-BR'));

  const result = {
    total: items.length,
    items,
    matriculados_snapshot_id: matSnap.id,
    docs_snapshot_id: docsSnap.id,
    generated_at: new Date().toISOString(),
  };

  activationListCache = {
    key: cacheKey,
    expires: Date.now() + ACTIVATION_CACHE_TTL_MS,
    data: result,
  };

  return result;
}

export function invalidateActivationListCache() {
  activationListCache = null;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** @param {unknown} lead */
function mapDatacrazyLead(lead) {
  if (!lead || typeof lead !== 'object') return null;
  const l = /** @type {Record<string, unknown>} */ (lead);
  const tags = Array.isArray(l.tags) ? l.tags : [];
  return {
    id: String(l.id ?? ''),
    name: String(l.name ?? ''),
    email: String(l.email ?? ''),
    phone: String(l.rawPhone ?? l.phone ?? ''),
    source: String(l.source ?? ''),
    tags: tags.map((t) => {
      if (t && typeof t === 'object' && 'name' in t) return String(t.name);
      return String(t);
    }),
  };
}

const DATACRAZY_MIN_INTERVAL_MS = Number(process.env.DATACRAZY_MIN_INTERVAL_MS) || 1100;

/**
 * Busca leads no DataCrazy para um lote da lista de ativação.
 * @param {{ offset?: number, limit?: number }} opts
 */
export async function enrichDocsPendentesWithDatacrazy(opts = {}) {
  if (!process.env.DATACRAZY_API_KEY) {
    const err = new Error('DATACRAZY_API_KEY não configurada no .env');
    err.status = 503;
    throw err;
  }

  const list = await getDocsPendentesActivationList();
  const offset = Math.max(Number(opts.offset) || 0, 0);
  const limit = Math.min(Math.max(Number(opts.limit) || 25, 1), 50);
  const slice = list.items.slice(offset, offset + limit);

  /** @type {object[]} */
  const results = [];
  let found = 0;
  let notFound = 0;
  let errors = 0;

  for (const item of slice) {
    try {
      const lead = await datacrazyClient.findLeadByContact({
        email: item.email,
        phone: item.telefone,
        name: item.nome,
      });
      if (lead) {
        found += 1;
        results.push({
          ...item,
          datacrazy_found: true,
          datacrazy: mapDatacrazyLead(lead),
        });
      } else {
        notFound += 1;
        results.push({
          ...item,
          datacrazy_found: false,
          datacrazy: null,
        });
      }
    } catch (err) {
      errors += 1;
      results.push({
        ...item,
        datacrazy_found: false,
        datacrazy: null,
        datacrazy_error: err instanceof Error ? err.message : 'Erro na API',
      });
    }
    await sleep(DATACRAZY_MIN_INTERVAL_MS);
  }

  return {
    total: list.total,
    offset,
    limit,
    processed: slice.length,
    found,
    not_found: notFound,
    errors,
    results,
    has_more: offset + slice.length < list.total,
    next_offset: offset + slice.length,
  };
}

/**
 * @param {ReturnType<typeof rowToActivationItem>[]} items
 */
export function activationListToCsv(items) {
  const headers = [
    'nome',
    'email',
    'telefone',
    'rgm',
    'cpf',
    'polo',
    'curso',
    'ciclo',
    'situacao_matricula',
    'datacrazy_id',
    'datacrazy_nome',
    'datacrazy_email',
    'datacrazy_telefone',
  ];
  const esc = (v) => {
    const s = String(v ?? '');
    if (s.includes('"') || s.includes(',') || s.includes('\n')) {
      return `"${s.replace(/"/g, '""')}"`;
    }
    return s;
  };
  const lines = [headers.join(',')];
  for (const row of items) {
    const dc = row.datacrazy || {};
    lines.push(
      [
        row.nome,
        row.email,
        row.telefone,
        row.rgm,
        row.cpf,
        row.polo,
        row.curso,
        row.ciclo,
        row.situacao_matricula,
        dc.id,
        dc.name,
        dc.email,
        dc.phone,
      ]
        .map(esc)
        .join(',')
    );
  }
  return `\uFEFF${lines.join('\n')}`;
}
