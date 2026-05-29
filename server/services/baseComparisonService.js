import * as baseUploadRepo from '../repositories/baseUploadRepository.js';
import {
  caaCancelamentoPendenteSqlWhere,
  caaCancelamentoSqlWhere,
  isCaaCancelamentoPendente,
  isCaaCancelamentoSolicitacao,
} from '../utils/caaRowFilters.js';
import { cicloFromRow, compareCicloSets } from '../utils/cicloFromRow.js';
import { shouldReplaceEvasaoRow } from '../utils/evasaoDedup.js';
import { personNameFromRow } from '../utils/personName.js';
import { isLikelyErpMatriculaRgm, normalizeRgmCanonical } from '../utils/rgmDisplay.js';

/** @typedef {{ ids: Set<string>, ciclos: Set<string>, row?: Record<string, unknown> }} PersonIndexEntry */

const RGM_KEYS = [
  'RGM',
  'Rgm',
  'rgm',
  'Matricula',
  'matricula',
  'MATRICULA',
  'Matrícula',
  'MATRÍCULA',
  'matrícula',
  'Username',
  'username',
  'Login',
  'login',
];

const CPF_KEYS = [
  'CPF',
  'Cpf Aluno',
  'Cpf',
  'cpf',
  'CPF Aluno',
  'Cpf do Aluno',
  'CPF do Aluno',
  'Documento',
];

const EMAIL_KEYS = [
  'Email',
  'E-mail',
  'email',
  'EMAIL',
  'e-mail',
  'E-Mail',
  'Email Aluno',
  'E-mail Aluno',
  'Email do Aluno',
];

const TEL_KEYS = [
  'Fone celular',
  'Celular',
  'Telefone',
  'telefone',
  'Fone',
  'Celular Aluno',
  'Telefone Aluno',
  'Fone Celular',
];

/** @param {unknown} v */
function digits(v) {
  return String(v ?? '')
    .replace(/\D/g, '')
    .trim();
}

function normalizeEmail(v) {
  const s = String(v ?? '').trim().toLowerCase();
  if (s.length < 6 || !s.includes('@')) return '';
  const [, domain] = s.split('@');
  return domain && domain.includes('.') ? s : '';
}

function normalizePhone(v) {
  let d = digits(v);
  if (d.length >= 12 && d.startsWith('55')) d = d.slice(2);
  return d.length >= 10 && d.length <= 11 ? d : '';
}

/**
 * @param {Record<string, unknown>} row
 * @param {{ category?: string }} [opts]
 * @returns {Set<string>}
 */
export function collectRowIdentities(row, opts = {}) {
  /** @type {Set<string>} */
  const out = new Set();
  for (const k of RGM_KEYS) {
    const raw = row[k];
    if (opts.category === 'matriculados' && isLikelyErpMatriculaRgm(raw)) continue;
    const rgm = normalizeRgmCanonical(raw);
    if (rgm) out.add(`RGM:${rgm}`);
  }
  for (const k of CPF_KEYS) {
    const d = digits(row[k]);
    if (d.length === 11) out.add(`CPF:${d}`);
  }
  for (const k of EMAIL_KEYS) {
    const e = normalizeEmail(row[k]);
    if (e) out.add(`EMAIL:${e}`);
  }
  for (const k of TEL_KEYS) {
    const t = normalizePhone(row[k]);
    if (t) out.add(`TEL:${t}`);
  }
  const nome = personNameFromRow(row);
  if (nome.length >= 10) out.add(`NOME:${nome}`);
  return out;
}

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

export function rowIdentity(row) {
  return canonicalFromIdentities(collectRowIdentities(row));
}

/**
 * @param {string} category
 * @param {{ caaOnlyPending?: boolean }} [opts]
 */
function rowFilterForCategory(category, opts = {}) {
  if (category === 'processos-caa') {
    return opts.caaOnlyPending ? isCaaCancelamentoPendente : isCaaCancelamentoSolicitacao;
  }
  return null;
}

/**
 * @param {string} category
 * @param {{ caaOnlyPending?: boolean }} [opts]
 */
function dataWhereSqlForCategory(category, opts = {}) {
  if (category === 'processos-caa') {
    return opts.caaOnlyPending ? caaCancelamentoPendenteSqlWhere() : caaCancelamentoSqlWhere();
  }
  return undefined;
}

/**
 * @param {PersonIndexEntry} a
 * @param {PersonIndexEntry} b
 */
function identityHit(a, b) {
  for (const id of a.ids) {
    if (b.ids.has(id)) return true;
  }
  return false;
}

/**
 * Índice invertido: id de identidade → entradas distintas (evita O(n×m) em bases grandes).
 * @param {Map<string, PersonIndexEntry>} byCanon
 * @returns {Map<string, PersonIndexEntry[]>}
 */
export function buildIdentityLookup(byCanon) {
  /** @type {Map<string, PersonIndexEntry[]>} */
  const lookup = new Map();
  for (const entry of byCanon.values()) {
    for (const id of entry.ids) {
      const list = lookup.get(id);
      if (list) {
        if (!list.includes(entry)) list.push(entry);
      } else {
        lookup.set(id, [entry]);
      }
    }
  }
  return lookup;
}

/**
 * @param {PersonIndexEntry} matEntry
 * @param {Iterable<PersonIndexEntry>} candidates
 * @returns {'none'|'aligned'|'cross_cycle'}
 */
function matchAgainstCandidates(matEntry, candidates) {
  let sawIdentity = false;
  let aligned = false;
  let crossOnly = false;
  for (const other of candidates) {
    if (!identityHit(matEntry, other)) continue;
    sawIdentity = true;
    const cmp = compareCicloSets(matEntry.ciclos, other.ciclos);
    if (cmp === 'aligned' || cmp === 'missing') {
      aligned = true;
      break;
    }
    if (cmp === 'divergent') crossOnly = true;
  }
  if (!sawIdentity) return 'none';
  if (aligned) return 'aligned';
  if (crossOnly) return 'cross_cycle';
  return 'none';
}

/**
 * Cruzamento matriculados × outra base respeitando ciclo quando ambos informam.
 * @param {PersonIndexEntry} matEntry
 * @param {Map<string, PersonIndexEntry>} otherByCanon
 * @param {Map<string, PersonIndexEntry[]>} [otherLookup]
 * @returns {'none'|'aligned'|'cross_cycle'}
 */
export function matchMatriculadoToOtherIndex(matEntry, otherByCanon, otherLookup) {
  const lookup = otherLookup ?? buildIdentityLookup(otherByCanon);
  /** @type {Set<PersonIndexEntry>} */
  const candidates = new Set();
  for (const id of matEntry.ids) {
    const list = lookup.get(id);
    if (!list) continue;
    for (const entry of list) candidates.add(entry);
  }
  if (!candidates.size) return 'none';
  return matchAgainstCandidates(matEntry, candidates);
}

/**
 * @param {string} category
 * @param {string} snapshotId
 * @param {{ snapshotRowCount?: number, keepSampleRow?: boolean }} [opts]
 */
export async function buildPersonIndexFromSnapshot(category, snapshotId, opts = {}) {
  const snapshotRowCount = opts.snapshotRowCount;
  const keepSampleRow = opts.keepSampleRow === true;
  const filterOpts = { caaOnlyPending: opts.caaOnlyPending === true };
  const rowFilter = rowFilterForCategory(category, filterOpts);
  const dataWhereSql = dataWhereSqlForCategory(category, filterOpts);
  /** @type {Map<string, PersonIndexEntry>} */
  const byCanon = new Map();
  let skipped = 0;
  let rowCount = 0;
  const rowCountTotal = snapshotRowCount ?? 0;
  await baseUploadRepo.forEachRowDataForSnapshot(
    category,
    snapshotId,
    (row) => {
      rowCount += 1;
      if (rowFilter && !rowFilter(row)) return;
      const ids = collectRowIdentities(row, { category });
      if (ids.size === 0) {
        skipped += 1;
        return;
      }
      const canon = canonicalFromIdentities(ids);
      if (!canon) {
        skipped += 1;
        return;
      }
      const ciclo = cicloFromRow(row);
      const cur = byCanon.get(canon);
      if (!cur) {
        /** @type {PersonIndexEntry} */
        const entry = { ids: new Set(ids), ciclos: new Set() };
        if (ciclo) entry.ciclos.add(ciclo);
        if (keepSampleRow) entry.row = row;
        byCanon.set(canon, entry);
      } else {
        for (const id of ids) cur.ids.add(id);
        if (ciclo) cur.ciclos.add(ciclo);
        if (category === 'provavel-evasao' && keepSampleRow && shouldReplaceEvasaoRow(row, cur.row)) {
          cur.row = row;
        }
      }
    },
    { dataWhereSql }
  );
  return { byCanon, skipped, rowCount, rowCountTotal, rowFilterActive: Boolean(rowFilter) };
}

/** @param {Map<string, PersonIndexEntry>} byCanon */
function unionIdentitySet(byCanon) {
  /** @type {Set<string>} */
  const u = new Set();
  for (const { ids } of byCanon.values()) {
    for (const id of ids) u.add(id);
  }
  return u;
}

/** @param {Map<string, PersonIndexEntry>} matByCanon @param {Map<string, PersonIndexEntry>} otherByCanon */
function comparePersonIndexes(matByCanon, otherByCanon) {
  const otherLookup = buildIdentityLookup(otherByCanon);
  const matLookup = buildIdentityLookup(matByCanon);

  let intersecao = 0;
  let intersecao_ciclo_divergente = 0;
  let matriculados_match_identidade_ciclo_antigo = 0;

  for (const mat of matByCanon.values()) {
    const m = matchMatriculadoToOtherIndex(mat, otherByCanon, otherLookup);
    if (m === 'aligned') intersecao += 1;
    else if (m === 'cross_cycle') {
      intersecao_ciclo_divergente += 1;
      matriculados_match_identidade_ciclo_antigo += 1;
    }
  }

  let na_outra_sem_matricula = 0;
  let na_outra_ciclo_divergente = 0;
  for (const other of otherByCanon.values()) {
    const m = matchMatriculadoToOtherIndex(other, matByCanon, matLookup);
    if (m === 'none') na_outra_sem_matricula += 1;
    else if (m === 'cross_cycle') na_outra_ciclo_divergente += 1;
  }

  return {
    matriculados_distintos: matByCanon.size,
    na_outra_distintos: otherByCanon.size,
    intersecao,
    intersecao_ciclo_divergente,
    matriculados_match_identidade_ciclo_antigo,
    matriculados_sem_intersecao:
      matByCanon.size - intersecao - matriculados_match_identidade_ciclo_antigo,
    na_outra_sem_matricula,
    na_outra_ciclo_divergente,
  };
}

const COMPARISONS = [
  { id: 'docs-pendentes', title: 'Documentos pendentes', mode: 'other_is_problem_list' },
  { id: 'financeiro', title: 'Financeiro / inadimplência', mode: 'other_is_problem_list' },
  {
    id: 'provavel-evasao',
    title: 'Provável evasão',
    mode: 'other_is_problem_list',
  },
  { id: 'acessos-blackboard', title: 'Acessos Blackboard', mode: 'other_is_coverage_list' },
  {
    id: 'processos-caa',
    title: 'CAA — solicitações de cancelamento',
    mode: 'other_is_process_list',
  },
];

function snapshotDto(row) {
  if (!row) return null;
  return {
    id: row.id,
    file_name: row.file_name,
    row_count: row.row_count,
    created_at: row.created_at,
  };
}

const COMPARISON_CACHE_TTL_MS = 10 * 60 * 1000;
/** @type {{ expires: number, data: object } | null} */
let comparisonCache = null;
/** @type {Promise<object> | null} */
let comparisonInFlight = null;

/** @type {Map<string, { expires: number, data: Awaited<ReturnType<typeof buildPersonIndexFromSnapshot>> }>} */
const personIndexCaches = new Map();

export function invalidateComparisonCache() {
  comparisonCache = null;
  comparisonInFlight = null;
  personIndexCaches.clear();
}

async function buildPersonIndexCached(category, snapshotId, snapshotRowCount) {
  const key = `${category}:${snapshotId}`;
  const hit = personIndexCaches.get(key);
  if (hit && hit.expires > Date.now()) return hit.data;
  const data = await buildPersonIndexFromSnapshot(category, snapshotId, { snapshotRowCount });
  personIndexCaches.set(key, { expires: Date.now() + COMPARISON_CACHE_TTL_MS, data });
  return data;
}

export function isComparisonBuilding() {
  return Boolean(comparisonInFlight);
}

export function getComparisonCacheMeta() {
  if (!comparisonCache || comparisonCache.expires <= Date.now()) return null;
  return { cached_at: comparisonCache.data.cached_at };
}

/** Dispara o cálculo em background se ainda não houver cache nem build em andamento. */
export function startComparisonBuildIfNeeded() {
  if (comparisonCache && comparisonCache.expires > Date.now()) return;
  if (comparisonInFlight) return;
  console.log('[comparison] iniciando cálculo em background…');
  void buildMatriculadosComparison()
    .then(() => console.log('[comparison] cache pronto.'))
    .catch((err) => console.error('[comparison] falhou:', err.message));
}

/**
 * Ciclos distintos presentes no matByCanon, ordenados desc.
 * @param {Map<string, PersonIndexEntry>} matByCanon
 * @returns {string[]}
 */
function extractAvailableCiclos(matByCanon) {
  const set = new Set();
  for (const entry of matByCanon.values()) {
    for (const c of entry.ciclos) {
      if (c) set.add(c);
    }
  }
  return [...set].sort((a, b) => b.localeCompare(a));
}

/**
 * Monta os blocks de comparação para um dado subconjunto de matByCanon.
 * @param {Map<string, PersonIndexEntry>} matByCanon
 * @param {{ rowCount: number, skipped: number }} matIndex
 * @param {Record<string, object>} otherSnaps
 * @param {object} matSnap
 */
async function buildBlocksForMat(matByCanon, matIndex, otherSnaps, matSnap) {
  /** @type {object[]} */
  const blocks = [];
  for (const def of COMPARISONS) {
    const otherSnap = otherSnaps[def.id];
    if (!otherSnap) {
      blocks.push({
        id: def.id,
        title: def.title,
        mode: def.mode,
        matriculados_snapshot: snapshotDto(matSnap),
        other_snapshot: null,
        matriculados_rows: matIndex.rowCount,
        matriculados_distintos: matByCanon.size,
        matriculados_sem_chave: matIndex.skipped,
        na_outra_distintos: 0,
        intersecao: 0,
        matriculados_sem_intersecao: matByCanon.size,
        na_outra_sem_matricula: 0,
        missing_other: true,
      });
      continue;
    }

    const otherIndex = await buildPersonIndexCached(def.id, otherSnap.id, otherSnap.row_count);
    const c = comparePersonIndexes(matByCanon, otherIndex.byCanon);
    const matriculados_sem_intersecao =
      def.mode === 'other_is_coverage_list'
        ? matByCanon.size - c.intersecao
        : c.matriculados_sem_intersecao;

    blocks.push({
      id: def.id,
      title: def.title,
      mode: def.mode,
      matriculados_snapshot: snapshotDto(matSnap),
      other_snapshot: snapshotDto(otherSnap),
      matriculados_rows: matIndex.rowCount,
      matriculados_distintos: c.matriculados_distintos,
      matriculados_sem_chave: matIndex.skipped,
      na_outra_rows: otherIndex.rowCount,
      na_outra_rows_total:
        otherIndex.rowFilterActive && otherIndex.rowCountTotal != null
          ? otherIndex.rowCountTotal
          : undefined,
      na_outra_filtro:
        def.id === 'processos-caa'
          ? 'Somente Subprocesso de cancelamento de matrícula (ex.: CANCELAMENTO DE MATRÍCULA).'
          : undefined,
      na_outra_distintos: c.na_outra_distintos,
      na_outra_sem_chave: otherIndex.skipped,
      intersecao: c.intersecao,
      intersecao_ciclo_divergente: c.intersecao_ciclo_divergente,
      matriculados_match_identidade_ciclo_antigo: c.matriculados_match_identidade_ciclo_antigo,
      matriculados_sem_intersecao,
      na_outra_sem_matricula: c.na_outra_sem_matricula,
      na_outra_ciclo_divergente: c.na_outra_ciclo_divergente,
      missing_other: false,
    });
  }
  return blocks;
}

async function buildMatriculadosComparisonInternal() {
  const matSnap = await baseUploadRepo.getLatestSnapshot('matriculados');
  if (!matSnap) {
    const err = new Error('Nenhum snapshot de matriculados. Envie a base ou rode o seed.');
    err.status = 404;
    throw err;
  }

  const matIndex = await buildPersonIndexCached('matriculados', matSnap.id, matSnap.row_count);
  const matByCanon = matIndex.byCanon;

  const otherSnaps = await baseUploadRepo.getLatestSnapshotsByCategory(
    COMPARISONS.map((c) => c.id)
  );

  // Blocos agregados (comportamento existente)
  const comparisons = await buildBlocksForMat(matByCanon, matIndex, otherSnaps, matSnap);

  // Segmentação por ciclo
  const available_ciclos = extractAvailableCiclos(matByCanon);
  /** @type {Record<string, { blocks: object[] }>} */
  const by_ciclo = {};
  for (const ciclo of available_ciclos) {
    const filteredMat = new Map();
    for (const [canon, entry] of matByCanon) {
      if (entry.ciclos.has(ciclo)) filteredMat.set(canon, entry);
    }
    by_ciclo[ciclo] = { blocks: await buildBlocksForMat(filteredMat, matIndex, otherSnaps, matSnap) };
  }

  return {
    matriculados_snapshot: snapshotDto(matSnap),
    matriculados_distintos: matByCanon.size,
    matriculados_sem_chave: matIndex.skipped,
    comparisons,
    by_ciclo,
    available_ciclos,
    cached_at: new Date().toISOString(),
  };
}

export async function buildMatriculadosComparison() {
  if (comparisonCache && comparisonCache.expires > Date.now()) {
    return comparisonCache.data;
  }
  if (comparisonInFlight) {
    return comparisonInFlight;
  }

  comparisonInFlight = buildMatriculadosComparisonInternal()
    .then((data) => {
      comparisonCache = { expires: Date.now() + COMPARISON_CACHE_TTL_MS, data };
      console.log(
        `[comparison] pronto em memória (${data.matriculados_distintos} matriculados distintos).`
      );
      return data;
    })
    .finally(() => {
      comparisonInFlight = null;
    });

  return comparisonInFlight;
}
