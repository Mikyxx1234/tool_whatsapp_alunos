/**
 * Scheduler in-process da Régua Inteligente.
 *
 * Estratégia:
 *  - setInterval roda a cada SCHEDULER_INTERVAL_MS (default 60s)
 *  - claimBatch reivindica até SCHEDULER_BATCH_SIZE eventos pendentes (default 50)
 *    - usa UPDATE ... FOR UPDATE SKIP LOCKED, então é seguro contra concorrência
 *    - já incrementa attempts e marca status='processing'
 *  - cada evento é processado pelo provider correto (whatsapp / email)
 *  - sucesso -> markSent
 *  - falha -> markFailureOrRetry (retry com backoff até max_attempts)
 *  - locks órfãos (>10min em processing) são liberados no início de cada ciclo
 *
 * TODO [CURSOR]: futuramente migrar para worker separado ou BullMQ + Redis.
 */

import * as scheduledEventRepo from '../repositories/scheduledEventRepository.js';
import * as studentRepo from '../repositories/studentRepository.js';
import * as templateRepo from '../repositories/campaignTemplateRepository.js';
import * as timelineRepo from '../repositories/timelineRepository.js';
import * as messageLogRepo from '../repositories/messageLogRepository.js';
import { messagingProvider } from './messagingProvider.js';
import { emailClient } from './emailClient.js';
import { isDbConfigured } from '../db/client.js';

let intervalHandle = null;
let isRunning = false;
let runningCycle = false;

function getConfig() {
  return {
    enabled: String(process.env.SCHEDULER_ENABLED || 'true').toLowerCase() !== 'false',
    intervalMs: Number(process.env.SCHEDULER_INTERVAL_MS) || 60_000,
    batchSize: Number(process.env.SCHEDULER_BATCH_SIZE) || 50,
    staleLockMinutes: Number(process.env.SCHEDULER_STALE_LOCK_MIN) || 10,
  };
}

function buildVariables(student) {
  return {
    nome: student.nome || '',
    name: student.nome || '',
    email: student.email || '',
    curso: student.curso || '',
    course: student.curso || '',
    polo: student.polo || '',
    telefone: student.telefone_normalizado || '',
    phone: student.telefone_normalizado || '',
    cpf: student.cpf || '',
    ...((student.raw_data && typeof student.raw_data === 'object') ? student.raw_data : {}),
  };
}

async function processWhatsappEvent(event, student, template) {
  if (!template?.nome_template) {
    throw new Error('Template do evento sem nome_template configurado.');
  }
  if (!student.telefone_normalizado) {
    throw new Error('Aluno sem telefone_normalizado.');
  }

  const variables = buildVariables(student);
  const payload = {
    phone: student.telefone_normalizado,
    templateName: template.nome_template,
    language: template.template_language || 'pt_BR',
    variables,
  };

  await messageLogRepo.create({
    direction: 'outbound',
    provider: messagingProvider.getName(),
    normalizedPhone: payload.phone,
    templateName: payload.templateName,
    payload: { ...payload, scheduledEventId: event.id, studentId: student.id },
    status: 'queued',
  });

  const result = await messagingProvider.sendTemplateMessage(payload);

  await messageLogRepo.create({
    direction: 'outbound',
    provider: messagingProvider.getName(),
    providerMessageId: result.messageId,
    normalizedPhone: payload.phone,
    templateName: payload.templateName,
    payload,
    response: result.raw,
    status: 'sent',
    sentAt: new Date(),
  });

  return result;
}

async function processEmailEvent(event, student, template) {
  if (!student.email) throw new Error('Aluno sem email.');
  const subject = template?.conteudo
    ? template.conteudo.split('\n')[0].slice(0, 120)
    : `Mensagem ${event.event_type || ''}`.trim();
  return emailClient.sendEmailMessage({
    to: student.email,
    subject,
    text: template?.conteudo,
    variables: buildVariables(student),
  });
}

async function processSingleEvent(event) {
  let student = null;
  let template = null;
  try {
    student = await studentRepo.findById(event.student_id);
    if (!student) throw new Error('Aluno não encontrado.');
    if (student.status === 'iniciado' || student.status === 'cancelado' || student.status === 'inativo') {
      // não envia se aluno saiu da régua
      await scheduledEventRepo.cancelById(event.id, `Status do aluno: ${student.status}`);
      await timelineRepo
        .record({
          studentId: student.id,
          eventType: 'event_skipped',
          title: `Evento ${event.event_type} ignorado`,
          description: `Aluno está com status "${student.status}".`,
          metadata: { eventId: event.id },
        })
        .catch(() => {});
      return { skipped: true };
    }

    if (event.template_id) {
      template = await templateRepo.findById(event.template_id);
    }

    let result;
    if (event.canal === 'whatsapp') {
      result = await processWhatsappEvent(event, student, template);
    } else if (event.canal === 'email') {
      result = await processEmailEvent(event, student, template);
    } else {
      throw new Error(`Canal desconhecido: ${event.canal}`);
    }

    await scheduledEventRepo.markSent(event.id, {
      providerMessageId: result?.messageId,
    });

    await timelineRepo
      .record({
        studentId: student.id,
        eventType: 'message_sent',
        title: `Mensagem enviada (${event.event_type || 'régua'})`,
        description: `Canal: ${event.canal}. Template: ${template?.nome_template || 'n/d'}.`,
        metadata: {
          scheduledEventId: event.id,
          providerMessageId: result?.messageId || null,
          template: template?.nome_template,
        },
      })
      .catch(() => {});

    return { ok: true, result };
  } catch (err) {
    const errorMessage = err?.message || 'Falha desconhecida';
    const retryResult = await scheduledEventRepo.markFailureOrRetry(
      event.id,
      errorMessage
    );

    if (student) {
      await timelineRepo
        .record({
          studentId: student.id,
          eventType: retryResult?.retried ? 'message_retry' : 'message_failed',
          title: retryResult?.retried
            ? `Falha ao enviar (${event.event_type}) — agendado retry`
            : `Falha definitiva (${event.event_type})`,
          description: errorMessage,
          metadata: {
            scheduledEventId: event.id,
            attempts: retryResult?.event?.attempts,
            retried: retryResult?.retried,
          },
        })
        .catch(() => {});
    }

    return { ok: false, error: errorMessage, retried: retryResult?.retried };
  }
}

async function runOneCycle() {
  if (runningCycle) {
    console.warn('[scheduler] ciclo anterior ainda rodando — pulando este tick.');
    return { skipped: true };
  }
  runningCycle = true;
  const startedAt = Date.now();
  const cfg = getConfig();
  let claimed = [];
  try {
    // 1. libera locks órfãos
    await scheduledEventRepo.releaseStaleLocks(cfg.staleLockMinutes).catch(() => {});

    // 2. reivindica lote
    claimed = await scheduledEventRepo.claimBatch(cfg.batchSize);
    if (claimed.length === 0) return { processed: 0, durationMs: Date.now() - startedAt };

    // 3. processa em série (mantém ordem cronológica). Para paralelizar
    //    no futuro: Promise.all com pool de concorrência.
    let success = 0;
    let failed = 0;
    let skipped = 0;
    for (const event of claimed) {
      const r = await processSingleEvent(event);
      if (r?.skipped) skipped += 1;
      else if (r?.ok) success += 1;
      else failed += 1;
    }
    const durationMs = Date.now() - startedAt;
    console.log(
      `[scheduler] ciclo: ${claimed.length} eventos | ok=${success} fail=${failed} skip=${skipped} | ${durationMs}ms`
    );
    return { processed: claimed.length, success, failed, skipped, durationMs };
  } catch (err) {
    console.error('[scheduler] erro no ciclo:', err.message);
    return { error: err.message };
  } finally {
    runningCycle = false;
  }
}

export function startScheduler() {
  if (intervalHandle) return;
  const cfg = getConfig();
  if (!cfg.enabled) {
    console.log('[scheduler] desabilitado (SCHEDULER_ENABLED=false).');
    return;
  }
  if (!isDbConfigured()) {
    console.warn(
      '[scheduler] DATABASE_URL não configurada. Scheduler NÃO foi iniciado.'
    );
    return;
  }
  isRunning = true;
  console.log(
    `[scheduler] iniciado: intervalo ${cfg.intervalMs}ms, lote ${cfg.batchSize}.`
  );
  // Roda imediatamente uma primeira vez (não bloqueia)
  runOneCycle().catch((err) => console.error('[scheduler] primeira execução:', err));
  intervalHandle = setInterval(() => {
    runOneCycle().catch((err) => console.error('[scheduler] tick:', err));
  }, cfg.intervalMs);
  // Não impede o processo de encerrar (deploy graceful)
  if (typeof intervalHandle.unref === 'function') intervalHandle.unref();
}

export function stopScheduler() {
  if (intervalHandle) {
    clearInterval(intervalHandle);
    intervalHandle = null;
  }
  isRunning = false;
}

/** Útil em smoke tests / endpoints internos: roda 1 ciclo on-demand. */
export async function runSingleCycle() {
  return runOneCycle();
}

export function getSchedulerStatus() {
  const cfg = getConfig();
  return { running: isRunning, ...cfg };
}

export const schedulerService = {
  startScheduler,
  stopScheduler,
  runSingleCycle,
  getSchedulerStatus,
};
