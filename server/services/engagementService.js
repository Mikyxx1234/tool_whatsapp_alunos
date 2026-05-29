import * as studentRepo from '../repositories/studentRepository.js';
import * as scheduledEventRepo from '../repositories/scheduledEventRepository.js';
import * as timelineRepo from '../repositories/timelineRepository.js';
import { diffInDays } from '../utils/dateParser.js';

/**
 * Marca o aluno como tendo acessado a plataforma.
 * Cancela eventos futuros pendentes (ele não precisa mais ser cobrado)
 * e registra na timeline.
 */
export async function markStudentAccessed(studentId, accessDate = new Date()) {
  const updated = await studentRepo.updateStatus(studentId, 'iniciado', {
    ultimo_acesso: accessDate,
  });
  if (!updated) return null;

  const cancelledCount = await scheduledEventRepo.cancelFutureForStudent(
    studentId,
    'Aluno acessou a plataforma'
  );

  await timelineRepo
    .record({
      studentId,
      eventType: 'access_detected',
      title: 'Aluno acessou a plataforma',
      description: `Status alterado para "iniciado". ${cancelledCount} evento(s) futuro(s) cancelado(s).`,
      metadata: { accessDate, cancelledFuture: cancelledCount },
    })
    .catch(() => {});

  await studentRepo.adjustEngagementScore(studentId, 10).catch(() => {});

  return { student: updated, cancelledFuture: cancelledCount };
}

export async function markStudentInactive(studentId, reason) {
  const updated = await studentRepo.updateStatus(studentId, 'inativo');
  if (!updated) return null;
  await timelineRepo
    .record({
      studentId,
      eventType: 'student_inactive',
      title: 'Aluno marcado como inativo',
      description: reason || 'Inativação manual.',
      metadata: { reason },
    })
    .catch(() => {});
  return updated;
}

/**
 * Atualização simples do engagement_score (MVP).
 *  - +10 se respondeu uma mensagem
 *  - +10 se acessou a plataforma
 *  -  5 se não respondeu (chamada via batch)
 *  - 10 se nunca acessou após D+3 (chamada via batch)
 */
export async function updateEngagementScore(studentId, signal) {
  const deltas = {
    responded: 10,
    accessed: 10,
    no_response: -5,
    no_access_after_d3: -10,
  };
  const delta = deltas[signal] ?? 0;
  if (delta === 0) return null;
  return studentRepo.adjustEngagementScore(studentId, delta);
}

/**
 * Helper para o scheduler: verifica se o aluno está atrasado D+3 e ainda
 * não acessou. Retorna true se for o caso (sinaliza recuperação).
 */
export function isStudentOverdueAfterD3(student) {
  if (!student?.data_matricula) return false;
  const days = diffInDays(student.data_matricula, new Date());
  return days !== null && days >= 3 && !student.ultimo_acesso;
}
