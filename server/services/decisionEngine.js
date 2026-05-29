import { diffInDays, toIsoDate } from '../utils/dateParser.js';
import * as studentRepo from '../repositories/studentRepository.js';
import * as timelineRepo from '../repositories/timelineRepository.js';

/**
 * Decision Engine v2 — Régua Inteligente.
 *
 * Resolve datas e fluxo respeitando:
 *   1) overrides individuais do aluno
 *   2) datas/regras da turma (academic_terms)
 *   3) defaults globais (journey_settings com scope=GLOBAL)
 *
 * E classifica o GAP de acordo com `gap_threshold_a` / `gap_threshold_b`
 * vindos do banco (em vez dos antigos 2/30 hardcoded).
 */

const DEFAULT_THRESHOLDS = { a: 2, b: 30 };

/**
 * Devolve as datas EFETIVAS do aluno (override > turma > campo legado).
 * Também devolve os "snapshots" da turma e settings, pra o caller logar.
 */
export function resolveStudentDates(row) {
  // row pode vir do `findWithTermAndSettings` (com term_*) OU do findById (legado).
  const data_matricula = toIsoDate(row.data_matricula);

  const fromTermInicio = row.term_inicio_conteudo
    ? toIsoDate(row.term_inicio_conteudo)
    : null;
  const data_inicio_conteudo = toIsoDate(
    row.override_data_inicio_conteudo
      || fromTermInicio
      || row.data_inicio_conteudo
  );

  const data_acesso_liberado = toIsoDate(
    row.override_data_acesso_liberado || row.data_acesso_liberado
  );

  return { data_matricula, data_inicio_conteudo, data_acesso_liberado };
}

export function classifyByGap(gapDias, thresholds = DEFAULT_THRESHOLDS) {
  const a = Number.isFinite(thresholds?.a) ? thresholds.a : DEFAULT_THRESHOLDS.a;
  const b = Number.isFinite(thresholds?.b) ? thresholds.b : DEFAULT_THRESHOLDS.b;
  if (gapDias === null || gapDias === undefined || Number.isNaN(gapDias)) {
    return {
      fluxo: null,
      reason: 'GAP indisponível: faltam datas de matrícula ou início do conteúdo.',
    };
  }
  if (gapDias <= a) {
    return { fluxo: 'A', reason: `GAP de ${gapDias} dia(s) (≤${a}) → ativação imediata.` };
  }
  if (gapDias <= b) {
    return { fluxo: 'B', reason: `GAP de ${gapDias} dias (${a + 1}-${b}) → espera curta.` };
  }
  return { fluxo: 'C', reason: `GAP de ${gapDias} dias (>${b}) → espera longa.` };
}

/**
 * Versão "pura": apenas calcula a partir dos dados em memória.
 * Aceita tanto o shape simples (student) quanto o shape estendido com
 * `term_...` e `journey_settings` (vindo de findWithTermAndSettings).
 */
export function calculateStudentJourney(input) {
  if (!input) {
    return { gap_dias: null, fluxo: null, reason: 'aluno inexistente', dates: null };
  }
  const dates = resolveStudentDates(input);
  const gap = diffInDays(dates.data_matricula, dates.data_inicio_conteudo);
  const thresholds = {
    a: input.gap_threshold_a ?? DEFAULT_THRESHOLDS.a,
    b: input.gap_threshold_b ?? DEFAULT_THRESHOLDS.b,
  };
  const { fluxo, reason } = classifyByGap(gap, thresholds);
  return {
    gap_dias: gap,
    fluxo,
    reason,
    dates,
    thresholds,
  };
}

/**
 * Versão persistente: carrega aluno + turma + settings do banco, calcula,
 * atualiza o aluno e registra timeline.
 */
export async function applyStudentJourney(studentId, client) {
  const row = await studentRepo.findWithTermAndSettings(studentId, client);
  if (!row) throw new Error(`Aluno ${studentId} não encontrado`);

  const result = calculateStudentJourney(row);
  const updated = await studentRepo.updateJourneyFields(
    studentId,
    { gap_dias: result.gap_dias, fluxo: result.fluxo },
    client
  );

  await timelineRepo
    .record(
      {
        studentId,
        eventType: 'flow_calculated',
        title: result.fluxo
          ? `Fluxo ${result.fluxo} atribuído`
          : 'Fluxo não pôde ser calculado',
        description: result.reason,
        metadata: {
          gap_dias: result.gap_dias,
          fluxo: result.fluxo,
          thresholds: result.thresholds,
          dates: result.dates,
          term_id: row.term_id || null,
        },
      },
      client
    )
    .catch((err) => {
      console.warn('[decisionEngine] timeline record falhou:', err.message);
    });

  return { ...result, student: updated };
}
