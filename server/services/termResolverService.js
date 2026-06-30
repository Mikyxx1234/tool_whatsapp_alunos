import * as academicTermRepo from '../repositories/academicTermRepository.js';
import { cicloFromRow, normalizeCiclo } from '../utils/cicloFromRow.js';
import { parseFlexibleDate } from '../utils/dateParser.js';

/**
 * @typedef {Object} AcademicTermLite
 * @property {string} id
 * @property {string} codigo
 * @property {string} nome
 * @property {string|null} inicio_matricula     ISO date
 * @property {string|null} fim_matricula        ISO date
 * @property {string|null} inicio_conteudo      ISO date
 * @property {string|null} fim_conteudo         ISO date
 * @property {boolean} tem_ambientacao
 * @property {number} dias_ambientacao
 * @property {boolean} conteudo_previo_liberado
 * @property {boolean} ativo
 */

/** Pré-engajamento na fila Aguardando início — só nos últimos N dias antes do início efetivo. */
export const PRE_ENGAGEMENT_DAYS = 14;

/**
 * @typedef {'sem_turma'|'pre_engajamento'|'conteudo_previo'|'turma_ativa'} TermActivationPhase
 */

/**
 * Carrega turmas ativas e devolve um objeto com utilitários de resolução.
 * Cache local de 5min para evitar query toda chamada de fila.
 */
let cache = /** @type {{ data: AcademicTermLite[], expires: number } | null} */ (null);
const TTL_MS = 5 * 60 * 1000;

function parseTermDate(value, endOfDay = false) {
  if (value === null || value === undefined || value === '') return null;
  const raw = String(value).trim();
  if (!raw) return null;
  const withTime = raw.includes('T')
    ? raw
    : `${raw}${endOfDay ? 'T23:59:59Z' : 'T00:00:00Z'}`;
  const d = parseFlexibleDate(withTime);
  return d && !Number.isNaN(d.getTime()) ? d : null;
}

export async function loadTerms() {
  if (cache && cache.expires > Date.now()) return cache.data;
  const all = await academicTermRepo.list({ ativoOnly: true });
  cache = { data: all, expires: Date.now() + TTL_MS };
  return all;
}

export function invalidateTermsCache() {
  cache = null;
}

/**
 * Dada uma data de matrícula (Date|string|serial Excel) e a lista de turmas,
 * encontra a turma cuja janela [inicio_matricula, fim_matricula] contém a data.
 *
 * @param {AcademicTermLite[]} terms
 * @param {Date|string|number} dataMatricula
 */
export function findTermByMatriculaDate(terms, dataMatricula) {
  const d = parseFlexibleDate(dataMatricula);
  if (!d) return null;
  const ts = d.getTime();
  for (const t of terms) {
    if (!t.inicio_matricula || !t.fim_matricula) continue;
    const iniDate = parseTermDate(t.inicio_matricula, false);
    const fimDate = parseTermDate(t.fim_matricula, true);
    if (!iniDate || !fimDate) continue;
    const ini = iniDate.getTime();
    const fim = fimDate.getTime();
    if (ts >= ini && ts <= fim) return t;
  }
  return null;
}

/** @param {Record<string, unknown>} row */
export function dataMatriculaFromRow(row) {
  return (
    row['Data Matrícula'] ??
    row['Data Matricula'] ??
    row['Data da Matricula'] ??
    row['Data de Matrícula']
  );
}

/**
 * Resolve a turma do aluno matriculado.
 * 1) Ciclo da planilha = ciclo cadastrado na turma (ex.: 2026/2 → 2026/2-Ago).
 * 2) Fallback: data de matrícula dentro da janela [inicio_matricula, fim_matricula].
 *
 * @param {AcademicTermLite[]} terms
 * @param {Record<string, unknown>} row
 */
export function findTermForMatriculadoRow(terms, row) {
  const active = (terms || []).filter((t) => t.ativo !== false);
  const rowCiclo = cicloFromRow(row);
  if (rowCiclo) {
    const byCiclo = active.filter((t) => normalizeCiclo(t.ciclo) === rowCiclo);
    if (byCiclo.length === 1) return byCiclo[0];
    if (byCiclo.length > 1) {
      const dataMat = dataMatriculaFromRow(row);
      if (dataMat) {
        const byDate = findTermByMatriculaDate(byCiclo, dataMat);
        if (byDate) return byDate;
      }
      return byCiclo[0];
    }
  }
  const dataMat = dataMatriculaFromRow(row);
  return dataMat ? findTermByMatriculaDate(active, dataMat) : null;
}

/**
 * @param {AcademicTermLite|null|undefined} term
 * @returns {number|null} ms UTC do início efetivo (inicio_conteudo − ambientação)
 */
export function getTermEffectiveStartMs(term) {
  if (!term?.inicio_conteudo) return null;
  const inicioDate = parseTermDate(term.inicio_conteudo, false);
  if (!inicioDate) return null;
  const ambientacao = term.tem_ambientacao ? Number(term.dias_ambientacao || 0) : 0;
  return inicioDate.getTime() - ambientacao * 86400000;
}

/**
 * Classifica em qual fase de ativação o aluno está, pela turma + hoje.
 *
 * - sem_turma: sem turma ou fora da janela de pré-engajamento (>14d)
 * - pre_engajamento: limbo, prévio OFF, faltam ≤14d pro início efetivo
 * - conteudo_previo: turma com conteúdo prévio liberado, início efetivo ainda não chegou
 * - turma_ativa: início efetivo já passou → elegível à fila Sem acesso BB
 *
 * @param {AcademicTermLite|null|undefined} term
 * @param {Date} [today]
 */
export function resolveTermActivationPhase(term, today = new Date()) {
  if (!term?.inicio_conteudo) {
    return {
      phase: 'sem_turma',
      daysUntilEffectiveStart: null,
      daysUntilOfficialStart: null,
      term: term || null,
    };
  }
  const inicioDate = parseTermDate(term.inicio_conteudo, false);
  if (!inicioDate) {
    return {
      phase: 'sem_turma',
      daysUntilEffectiveStart: null,
      daysUntilOfficialStart: null,
      term,
    };
  }

  const todayMs = today.getTime();
  const inicioMs = inicioDate.getTime();
  const effectiveStartMs = getTermEffectiveStartMs(term);

  const daysUntilOfficialStart = Math.ceil((inicioMs - todayMs) / 86400000);
  const daysUntilEffectiveStart =
    effectiveStartMs != null
      ? Math.ceil((effectiveStartMs - todayMs) / 86400000)
      : null;

  if (effectiveStartMs != null && todayMs >= effectiveStartMs) {
    return {
      phase: 'turma_ativa',
      daysUntilEffectiveStart: daysUntilEffectiveStart ?? 0,
      daysUntilOfficialStart,
      term,
    };
  }

  if (term.conteudo_previo_liberado) {
    return {
      phase: 'conteudo_previo',
      daysUntilEffectiveStart,
      daysUntilOfficialStart,
      term,
    };
  }

  if (
    daysUntilEffectiveStart != null &&
    daysUntilEffectiveStart > 0 &&
    daysUntilEffectiveStart <= PRE_ENGAGEMENT_DAYS
  ) {
    return {
      phase: 'pre_engajamento',
      daysUntilEffectiveStart,
      daysUntilOfficialStart,
      term,
    };
  }

  return {
    phase: 'sem_turma',
    daysUntilEffectiveStart,
    daysUntilOfficialStart,
    term,
  };
}

/**
 * Aluno está em "limbo" se o conteúdo da turma dele ainda não foi liberado
 * (pré-engajamento ou conteúdo prévio — não entra na fila BB).
 *
 * @param {AcademicTermLite & { tem_ambientacao?: boolean, dias_ambientacao?: number }} term
 * @param {Date} [today=new Date()]
 */
export function isInLimbo(term, today = new Date()) {
  const { phase } = resolveTermActivationPhase(term, today);
  return phase === 'pre_engajamento' || phase === 'conteudo_previo';
}

/**
 * Atalho: dada uma data de matrícula, retorna fase e contagem de dias.
 * @param {AcademicTermLite[]} terms
 * @param {Date|string|number} dataMatricula
 */
export function resolveLimbo(terms, dataMatricula, today = new Date()) {
  const term = findTermByMatriculaDate(terms, dataMatricula);
  const resolved = resolveTermActivationPhase(term, today);
  return {
    term: resolved.term,
    limbo: resolved.phase === 'pre_engajamento' || resolved.phase === 'conteudo_previo',
    daysUntilStart: resolved.daysUntilEffectiveStart,
    daysUntilOfficialStart: resolved.daysUntilOfficialStart,
    phase: resolved.phase,
  };
}
