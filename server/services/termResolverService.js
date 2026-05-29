import * as academicTermRepo from '../repositories/academicTermRepository.js';
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
 * @property {boolean} ativo
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

/**
 * Aluno está em "limbo" se o conteúdo da turma dele ainda não foi liberado.
 *
 * Considera ambientação: se a turma tem `tem_ambientacao` e `dias_ambientacao`,
 * o conteúdo é "liberado" a partir de (inicio_conteudo - dias_ambientacao).
 *
 * @param {AcademicTermLite & { tem_ambientacao?: boolean, dias_ambientacao?: number }} term
 * @param {Date} [today=new Date()]
 */
export function isInLimbo(term, today = new Date()) {
  if (!term || !term.inicio_conteudo) return false;
  const inicioDate = parseTermDate(term.inicio_conteudo, false);
  if (!inicioDate) return false;
  const inicio = inicioDate.getTime();
  const ambientacaoDias = term.tem_ambientacao ? Number(term.dias_ambientacao || 0) : 0;
  const liberadoEm = inicio - ambientacaoDias * 86400000;
  return today.getTime() < liberadoEm;
}

/**
 * Atalho: dada uma data de matrícula, retorna { term, limbo, daysUntilStart }.
 * @param {AcademicTermLite[]} terms
 * @param {Date|string|number} dataMatricula
 */
export function resolveLimbo(terms, dataMatricula, today = new Date()) {
  const term = findTermByMatriculaDate(terms, dataMatricula);
  if (!term) return { term: null, limbo: false, daysUntilStart: null };
  if (!term.inicio_conteudo) return { term, limbo: false, daysUntilStart: null };
  const inicioDate = parseTermDate(term.inicio_conteudo, false);
  if (!inicioDate) return { term, limbo: false, daysUntilStart: null };
  const inicio = inicioDate.getTime();
  const ambientacao = term.tem_ambientacao ? Number(term.dias_ambientacao || 0) : 0;
  const liberadoEm = inicio - ambientacao * 86400000;
  const daysUntilStart = Math.ceil((liberadoEm - today.getTime()) / 86400000);
  return {
    term,
    limbo: today.getTime() < liberadoEm,
    daysUntilStart,
  };
}
