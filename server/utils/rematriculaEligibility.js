import { cicloFromRow, normalizeCiclo } from './cicloFromRow.js';

export const REMAT_CICLO_ORIGEM = process.env.REMAT_CICLO_ORIGEM || '2026/1';
export const REMAT_CICLO_DESTINO = process.env.REMAT_CICLO_DESTINO || '2026/2';

const INSTITUICAO_KEYS = ['Instituição', 'Instituicao', 'INSTITUICAO', 'instituicao'];

/**
 * @param {Record<string, unknown>|undefined|null} row
 */
export function instituicaoFromRow(row) {
  if (!row || typeof row !== 'object') return '';
  for (const k of INSTITUICAO_KEYS) {
    const v = String(row[k] ?? '').trim();
    if (v) return v;
  }
  return '';
}

/**
 * Situação acadêmica — coluna F do SIAA (SIT_ATUAL) ou equivalente em outras bases.
 * @param {Record<string, unknown>|undefined|null} row
 */
export function rematSitAtualFromRow(row) {
  if (!row || typeof row !== 'object') return '';
  return String(row.SIT_ATUAL ?? row.Sit_Atual ?? '').trim().toUpperCase();
}

/** @param {Record<string, unknown>|undefined|null} row */
export function isRematriculaEmCursoRow(row) {
  const sitAtual = rematSitAtualFromRow(row);
  if (sitAtual) return isEmCurso(sitAtual);
  const sit = situacaoMatriculaFromRow(row);
  return isEmCurso(sit) && !isConcluinte(sit);
}

/**
 * Adimplente vs inadimplente a partir de SIT_FINAN (SIAA) ou equivalente.
 * Portal de Polos sem coluna financeira → inadimplente (arquivo de mensalidade vencida).
 * @param {Record<string, unknown>|undefined|null} row
 */
export function rematFinanceiroSubgrupoFromRow(row) {
  if (!row || typeof row !== 'object') return 'inadimplente';
  const fin = String(
    row.SIT_FINAN ?? row['Situação Financeira'] ?? row['Situação financeira'] ?? ''
  )
    .trim()
    .toUpperCase();
  if (/^INADIMPLENTE$/.test(fin)) return 'inadimplente';
  if (/^ADIMPLENTE$/.test(fin)) return 'adimplente';
  return 'inadimplente';
}

/** Graduação EAD UNICID, Cruzeiro (16) ou Braz Cubas — exclui Pós, técnico, cursos livres, etc. */
export function isRematriculaInstituicaoAllowed(row) {
  const inst = instituicaoFromRow(row);
  if (!inst) return false;
  const norm = inst.toUpperCase();
  if (norm.includes('UNICID')) return true;
  if (
    norm.includes('BRAZ CUBAS') &&
    (norm.includes('GRAD') || norm.includes('GRADUAÇÃO') || norm.includes('GRADUACAO')) &&
    !norm.includes('PÓS') &&
    !norm.includes('POS')
  ) {
    return true;
  }
  if (
    norm.includes('16 - CRUZEIRO') &&
    (norm.includes('GRADUAÇÃO EAD') || norm.includes('GRADUACAO EAD')) &&
    !norm.includes('PÓS') &&
    !norm.includes('POS')
  ) {
    return true;
  }
  return false;
}

const SITUACAO_KEYS = [
  'Situação Matrícula',
  'Situacao Matricula',
  'Situação Atendimento',
  'Situacao',
  'SIT_ATUAL',
  'SIT_2026_1',
];

/**
 * @param {Record<string, unknown>|undefined|null} row
 */
export function situacaoMatriculaFromRow(row) {
  if (!row || typeof row !== 'object') return '';
  for (const k of SITUACAO_KEYS) {
    const v = String(row[k] ?? '').trim();
    if (v) return v.toUpperCase();
  }
  return '';
}

/** @param {string} sit */
export function isEmCurso(sit) {
  return sit === 'EM CURSO';
}

/** @param {string} sit */
export function isConcluinte(sit) {
  const s = String(sit || '').toUpperCase();
  return s.includes('CONCLUINTE') || s === 'CONCLUIDO' || s === 'CONCLUÍDO';
}

/**
 * Canon keys de quem já aparece no ciclo destino (rematrícula concluída).
 * @param {{ byCanon: Map<string, { ciclos: Set<string> }> }} matIndex
 * @param {string} [cicloDestino]
 */
export function buildRematriculaConcluidaCanonSet(matIndex, cicloDestino = REMAT_CICLO_DESTINO) {
  const dest = normalizeCiclo(cicloDestino);
  const out = new Set();
  for (const [canon, entry] of matIndex.byCanon.entries()) {
    for (const c of entry.ciclos || []) {
      if (normalizeCiclo(c) === dest) {
        out.add(canon);
        break;
      }
    }
  }
  return out;
}

/**
 * @param {{ ids: Iterable<string> }} entry
 * @param {Map<string, unknown[]>} lookup
 */
export function isPersonInIdentityLookup(entry, lookup) {
  for (const id of entry.ids) {
    const list = lookup.get(id);
    if (list?.length) return true;
  }
  return false;
}

/**
 * @deprecated Preferir isRematriculaEmCursoRow — mantido para scripts de diagnóstico legados.
 * @param {Record<string, unknown>} row
 */
export function isRematriculaOrigemRow(row) {
  return isRematriculaEmCursoRow(row);
}
