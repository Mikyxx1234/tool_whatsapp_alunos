import * as studentRepo from '../repositories/studentRepository.js';
import * as scheduledEventRepo from '../repositories/scheduledEventRepository.js';
import * as templateRepo from '../repositories/campaignTemplateRepository.js';
import * as timelineRepo from '../repositories/timelineRepository.js';
import { applyStudentJourney, resolveStudentDates } from './decisionEngine.js';
import { withTransaction } from '../db/client.js';

/**
 * Receita oficial de cada fluxo. Cada item descreve um evento a gerar:
 *   - evento:    rótulo lógico (D0, D+1, D+3, D-7, D-1, LOOP, RECUPERACAO)
 *   - anchor:    'matricula' ou 'inicio'  (data de referência)
 *   - delayDays: deslocamento em dias a partir do anchor
 *   - canal:     'whatsapp' | 'email'
 *
 * O serviço busca o `campaign_template` correspondente via (canal, fluxo, evento).
 */
const RECIPES = {
  A: [
    { evento: 'D0',          anchor: 'matricula', delayDays: 0,  canal: 'whatsapp' },
    { evento: 'D+1',         anchor: 'matricula', delayDays: 1,  canal: 'whatsapp' },
    { evento: 'RECUPERACAO', anchor: 'matricula', delayDays: 3,  canal: 'whatsapp' },
  ],
  B: [
    { evento: 'D0',  anchor: 'matricula', delayDays: 0,  canal: 'whatsapp' },
    { evento: 'D+3', anchor: 'matricula', delayDays: 3,  canal: 'whatsapp' },
    { evento: 'D-7', anchor: 'inicio',    delayDays: -7, canal: 'whatsapp' },
    { evento: 'D-1', anchor: 'inicio',    delayDays: -1, canal: 'whatsapp' },
  ],
  C: [
    { evento: 'D0',  anchor: 'matricula', delayDays: 0,  canal: 'whatsapp' },
    // LOOP semanal é gerado dinamicamente abaixo
    { evento: 'D-7', anchor: 'inicio',    delayDays: -7, canal: 'whatsapp' },
    { evento: 'D-1', anchor: 'inicio',    delayDays: -1, canal: 'whatsapp' },
  ],
};

const LOOP_INTERVAL_DAYS = 7;
const LOOP_STOP_DAYS_BEFORE_INICIO = 10;

function addDays(baseDate, days) {
  const d = new Date(baseDate);
  d.setUTCDate(d.getUTCDate() + days);
  d.setUTCHours(13, 0, 0, 0); // padroniza horário do envio em ~10h BRT
  return d;
}

function pickAnchor(dates, anchor) {
  if (anchor === 'matricula') return dates.data_matricula;
  if (anchor === 'inicio') return dates.data_inicio_conteudo;
  return null;
}

/**
 * Gera eventos do LOOP (fluxo C) entre data_matricula e
 * (data_inicio_conteudo - 10 dias).
 */
function buildLoopEvents(dates, templateMap) {
  const tpl = templateMap.get('LOOP');
  if (!tpl) return [];
  if (!dates.data_matricula || !dates.data_inicio_conteudo) return [];
  const start = new Date(dates.data_matricula);
  const stop = new Date(dates.data_inicio_conteudo);
  stop.setUTCDate(stop.getUTCDate() - LOOP_STOP_DAYS_BEFORE_INICIO);

  const events = [];
  const cursor = addDays(start, LOOP_INTERVAL_DAYS);
  while (cursor <= stop) {
    events.push({
      template_id: tpl.id,
      canal: tpl.canal,
      event_type: 'LOOP',
      execution_date: new Date(cursor),
      metadata: { evento: 'LOOP', anchor: 'matricula' },
    });
    cursor.setUTCDate(cursor.getUTCDate() + LOOP_INTERVAL_DAYS);
  }
  return events;
}

/**
 * Gera os eventos da régua para um aluno, dada a sua classificação atual.
 * Antes de gerar, cancela eventos futuros pendentes para evitar duplicatas
 * (ex: quando o usuário recalcula a régua).
 *
 * @param {string} studentId
 * @param {{recalculateFlow?: boolean}} opts
 * @returns {Promise<{student, events, fluxo, gap_dias, skippedReason?}>}
 */
export async function generateJourneyEventsForStudent(studentId, opts = {}) {
  return withTransaction(async (client) => {
    // (1) Garante que gap/fluxo estejam atualizados (lê turma + settings)
    if (opts.recalculateFlow !== false) {
      await applyStudentJourney(studentId, client);
    }

    // Recarrega o shape estendido (com term_* e settings) pra usar datas
    // resolvidas (override > term > legado).
    const row = await studentRepo.findWithTermAndSettings(studentId, client);
    if (!row) throw new Error(`Aluno ${studentId} não encontrado.`);

    if (!row.fluxo) {
      return {
        student: row,
        events: [],
        fluxo: null,
        gap_dias: row.gap_dias,
        skippedReason: 'Fluxo indefinido — datas insuficientes para classificar.',
      };
    }

    const dates = resolveStudentDates(row);

    // (2) Cancela eventos futuros pendentes do aluno (se houver)
    await scheduledEventRepo.cancelFutureForStudent(
      studentId,
      'Régua regerada',
      client
    );

    // (3) Resolve templates ativos do fluxo/canal
    const templates = await templateRepo.listByFlow({
      canal: 'whatsapp',
      fluxo: row.fluxo,
    });
    const templateMap = new Map();
    for (const t of templates) templateMap.set(t.evento, t);

    // (4) Materializa a receita
    const recipe = RECIPES[row.fluxo] || [];
    const eventsPayload = [];
    for (const step of recipe) {
      const anchor = pickAnchor(dates, step.anchor);
      if (!anchor) continue;
      const tpl = templateMap.get(step.evento);
      const executionDate = addDays(anchor, step.delayDays);
      eventsPayload.push({
        student_id: studentId,
        template_id: tpl ? tpl.id : null,
        canal: step.canal,
        event_type: step.evento,
        execution_date: executionDate,
        metadata: {
          evento: step.evento,
          anchor: step.anchor,
          delayDays: step.delayDays,
          template_name: tpl?.nome_template || null,
          term_id: row.term_id || null,
        },
      });
    }

    // (5) Loop semanal (apenas fluxo C)
    if (row.fluxo === 'C') {
      const loopEvents = buildLoopEvents(dates, templateMap);
      eventsPayload.push(
        ...loopEvents.map((e) => ({ ...e, student_id: studentId }))
      );
    }

    if (eventsPayload.length === 0) {
      return {
        student: row,
        events: [],
        fluxo: row.fluxo,
        gap_dias: row.gap_dias,
        skippedReason: 'Nenhum evento aplicável (datas de referência ausentes).',
      };
    }

    const created = await scheduledEventRepo.bulkInsert(eventsPayload, client);

    await timelineRepo
      .record(
        {
          studentId,
          eventType: 'event_scheduled',
          title: `Régua gerada: ${created.length} evento(s) (fluxo ${row.fluxo})`,
          description: `Eventos D0/D+/D- agendados conforme fluxo ${row.fluxo}.`,
          metadata: {
            fluxo: row.fluxo,
            total: created.length,
            term_id: row.term_id || null,
            dates,
            eventos: created.map((e) => ({
              id: e.id,
              tipo: e.event_type,
              data: e.execution_date,
            })),
          },
        },
        client
      )
      .catch(() => {});

    return {
      student: row,
      events: created,
      fluxo: row.fluxo,
      gap_dias: row.gap_dias,
      dates,
    };
  });
}

/**
 * Cancela todos os eventos futuros pendentes de um aluno (ex: aluno acessou
 * a plataforma e não precisa mais ser cobrado).
 */
export async function cancelFutureEventsForStudent(studentId, reason) {
  const count = await scheduledEventRepo.cancelFutureForStudent(
    studentId,
    reason
  );
  if (count > 0) {
    await timelineRepo
      .record({
        studentId,
        eventType: 'future_events_cancelled',
        title: `${count} evento(s) futuro(s) cancelado(s)`,
        description: reason || 'Eventos futuros cancelados.',
        metadata: { count, reason },
      })
      .catch(() => {});
  }
  return count;
}

/**
 * Gera régua em lote para vários alunos. Usa transações por aluno —
 * uma falha em um não afeta os demais.
 */
export async function generateJourneyEventsBatch(studentIds, opts = {}) {
  const results = [];
  const errors = [];
  for (const id of studentIds) {
    try {
      const r = await generateJourneyEventsForStudent(id, opts);
      results.push(r);
    } catch (err) {
      errors.push({ studentId: id, error: err.message });
    }
  }
  return { results, errors };
}
