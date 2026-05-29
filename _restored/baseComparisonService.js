import * as baseUploadRepo from '../repositories/baseUploadRepository.js';

/** Colunas que costumam trazer RGM / matrícula / login numérico no BB. */
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
  'Nr Matrícula',
  'Nr Matricula',
  'Nº Matrícula',
  'Nº Matricula',
  'Número de matrícula',
  'Numero de matricula',
  'Matricula Academica',
  'Matrícula Acadêmica',
  'Matricula acadêmica',
  'Matricula Acadêmica',
  'Username',
  'username',
  'Nome de usuário',
  'Nome de Usuario',
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
  'CPF Aluno(a)',
  'Documento',
  'Doc. Aluno',
];

/** @param {unknown} v */
function digits(v) {
  return String(v ?? '')
    .replace(/\D/g, '')
    .trim();
}

/**
 * Todas as chaves RGM/CPF encontradas na linha. Permite cruzar planilha com RGM × outra só com CPF,
 * ou cabeçalhos diferentes (ex.: "Matrícula" com acento).
 * @param {Record<string, unknown>} row
 * @returns {Set<string>}
 */
export function collectRowIdentities(row) {
  /** @type {Set<string>} */
  const out = new Set();
  for (const k of RGM_KEYS) {
    const d = digits(row[k]);
    if (d.length >= 6) out.add(`RGM:${d}`);
  }
  for (const k of CPF_KEYS) {
    const d = digits(row[k]);
    if (d.length === 11) out.add(`CPF:${d}`);
  }
  return out;
}

/**
 * @param {Set<string>} ids
 * @returns {string|null}
 */
function canonicalFromIdentities(ids) {
  const list = [...ids];
  const rgms = list.filter((x) => x.startsWith('RGM:')).sort();
  const cpfs = list.filter((x) => x.startsWith('CPF:')).sort();
  if (rgms.length) return rgms[0];
  if (cpfs.length) return cpfs[0];
  return null;
}

/**
 * Uma chave canônica por pessoa (para contagem de distintos). Preferência: RGM, senão CPF.
 * @param {Record<string, unknown>} row
 */
export function rowIdentity(row) {
  return canonicalFromIdentities(collectRowIdentities(row));
}

/**
 * @param {Record<string, unknown>[]} rows
 * @returns {{ byCanon: Map<string, Set<string>>, skipped: number }}
 */
function buildPersonIndex(rows) {
  /** @type {Map<string, Set<string>>} */
  const byCanon = new Map();
  let skipped = 0;
  for (const row of rows) {
    const ids = collectRowIdentities(row);
    if (ids.size === 0) {
      skipped += 1;
      continue;
    }
    const canon = canonicalFromIdentities(ids);
    if (!canon) {
      skipped += 1;
      continue;
    }
    const cur = byCanon.get(canon);
    if (!cur) {
      byCanon.set(canon, new Set(ids));
    } else {
      for (const id of ids) cur.add(id);
    }
  }
  return { byCanon, skipped };
}

/** @param {Map<string, Set<string>>} byCanon */
function unionIdentitySet(byCanon) {
  /** @type {Set<string>} */
  const u = new Set();
  for (const ids of byCanon.values()) {
    for (const id of ids) u.add(id);
  }
  return u;
}

/**
 * Interseção se qualquer identidade do matriculado coincidir com qualquer identidade na outra base.
 * @param {Map<string, Set<string>>} matByCanon
 * @param {Map<string, Set<string>>} otherByCanon
 */
function comparePersonIndexes(matByCanon, otherByCanon) {
  const matUnion = unionIdentitySet(matByCanon);
  const otherUnion = unionIdentitySet(otherByCanon);
  let intersecao = 0;
  for (const ids of matByCanon.values()) {
    let hit = false;
    for (const id of ids) {
      if (otherUnion.has(id)) {
        hit = true;
        break;
      }
    }
    if (hit) intersecao += 1;
  }
  let na_outra_sem_matricula = 0;
  for (const ids of otherByCanon.values()) {
    let hitMat = false;
    for (const id of ids) {
      if (matUnion.has(id)) {
        hitMat = true;
        break;
      }
    }
    if (!hitMat) na_outra_sem_matricula += 1;
  }
  const matriculados_distintos = matByCanon.size;
  const na_outra_distintos = otherByCanon.size;
  return {
    matriculados_distintos,
    na_outra_distintos,
    intersecao,
    matriculados_sem_intersecao: matriculados_distintos - intersecao,
    na_outra_sem_matricula,
  };
}

/**
 * @typedef {'other_is_problem_list' | 'other_is_coverage_list' | 'other_is_process_list'} ComparisonMode
 */

const COMPARISONS = [
  {
    id: 'docs-pendentes',
    title: 'Documentos pendentes',
    mode: 'other_is_problem_list',
  },
  {
    id: 'financeiro',
    title: 'Financeiro / inadimplência',
    mode: 'other_is_problem_list',
  },
  {
    id: 'acessos-blackboard',
    title: 'Acessos Blackboard',
    mode: 'other_is_coverage_list',
  },
  {
    id: 'processos-caa',
    title: 'Processos CAA',
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

/**
 * Painel: matriculados = universo; demais bases cruzadas por RGM/CPF (qualquer coluna reconhecida por linha).
 */
export async function buildMatriculadosComparison() {
  const matSnap = await baseUploadRepo.getLatestSnapshot('matriculados');
  if (!matSnap) {
    const err = new Error('Nenhum snapshot de matriculados. Rode o seed ou envie a base.');
    err.status = 404;
    throw err;
  }

  const matRows = await baseUploadRepo.fetchAllRowDataForSnapshot('matriculados', matSnap.id);
  const { byCanon: matByCanon, skipped: matSkipped } = buildPersonIndex(matRows);

  const blocks = [];

  for (const def of COMPARISONS) {
    const otherSnap = await baseUploadRepo.getLatestSnapshot(def.id);
    if (!otherSnap) {
      blocks.push({
        id: def.id,
        title: def.title,
        mode: def.mode,
        matriculados_snapshot: snapshotDto(matSnap),
        other_snapshot: null,
        matriculados_rows: matRows.length,
        matriculados_distintos: matByCanon.size,
        matriculados_sem_chave: matSkipped,
        na_outra_distintos: 0,
        intersecao: 0,
        matriculados_sem_intersecao: matByCanon.size,
        na_outra_sem_matricula: 0,
        missing_other: true,
      });
      continue;
    }

    const otherRows = await baseUploadRepo.fetchAllRowDataForSnapshot(def.id, otherSnap.id);
    const { byCanon: otherByCanon, skipped: otherSkipped } = buildPersonIndex(otherRows);
    const c = comparePersonIndexes(matByCanon, otherByCanon);

    blocks.push({
      id: def.id,
      title: def.title,
      mode: def.mode,
      matriculados_snapshot: snapshotDto(matSnap),
      other_snapshot: snapshotDto(otherSnap),
      matriculados_rows: matRows.length,
      matriculados_distintos: c.matriculados_distintos,
      matriculados_sem_chave: matSkipped,
      na_outra_rows: otherRows.length,
      na_outra_distintos: c.na_outra_distintos,
      na_outra_sem_chave: otherSkipped,
      intersecao: c.intersecao,
      matriculados_sem_intersecao: c.matriculados_sem_intersecao,
      na_outra_sem_matricula: c.na_outra_sem_matricula,
      missing_other: false,
    });
  }

  return {
    matriculados_snapshot: snapshotDto(matSnap),
    matriculados_distintos: matByCanon.size,
    matriculados_sem_chave: matSkipped,
    comparisons: blocks,
  };
}
