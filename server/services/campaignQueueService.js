import { messagingProvider } from './messagingProvider.js';
import { whatsappClient } from './whatsappClient.js';
import * as campaignRepo from '../repositories/campaignRepository.js';
import * as contactRepo from '../repositories/contactRepository.js';
import * as messageLogRepo from '../repositories/messageLogRepository.js';
import * as eventRepo from '../repositories/eventRepository.js';
import { classifyFailure } from '../utils/failureClassifier.js';

/**
 * Throughput defaults (orientação de boas práticas).
 * - Meta Cloud API: limite real fica em ~80 msg/s para contas não verificadas,
 *   mas para campanhas de marketing recomenda-se intervalo conservador
 *   (1–3s) para preservar a "Quality Rating" do número.
 * - DataCrazy: 60 req/min por rota → mínimo 1s entre envios.
 *
 * Mantemos um piso de 1s configurável via env.
 */
const MIN_INTERVAL_SECONDS = Math.max(
  1,
  Number(process.env.MIN_INTERVAL_SECONDS) || 1
);
// Limite máximo de tentativas em caso de 429 antes de falhar o contato.
const MAX_RATE_LIMIT_RETRIES = 3;

/**
 * Worker em memória que executa as campanhas em andamento.
 *
 * Cada campanha possui um "controller" com flags `paused` e `cancelled`.
 * Em escala (múltiplos processos / restarts), trocar por uma fila persistida
 * (ex.: BullMQ + Redis) — TODO [CURSOR].
 */

const controllers = new Map();

const sleep = (ms) =>
  new Promise((resolve) => {
    if (ms <= 0) resolve();
    else setTimeout(resolve, ms);
  });

function getController(campaignId) {
  return controllers.get(campaignId) || null;
}

function buildVariables(contact) {
  return {
    nome: contact.name || '',
    name: contact.name || '',
    email: contact.email || '',
    curso: contact.course || '',
    course: contact.course || '',
    origem: contact.origem || '',
    telefone: contact.normalized_phone,
    phone: contact.normalized_phone,
    cpf: contact.cpf || '',
    student_id: contact.student_id || '',
    ...((contact.raw_data && typeof contact.raw_data === 'object') ? contact.raw_data : {}),
  };
}

async function processSingleContact(contact, campaign, runtimeCtx) {
  if (contact.send_status === 'sent') {
    return { skipped: true };
  }

  if (campaign.template_name && contact.normalized_phone) {
    const already = await contactRepo.wasTemplateSentToPhone(
      contact.normalized_phone,
      campaign.template_name,
      campaign.template_language,
      campaign.id
    );
    if (already) {
      await contactRepo.updateSendStatus(contact.id, 'skipped', {
        error_message: `Template "${campaign.template_name}" já enviado para este telefone.`,
      });
      return { skipped: true, reason: 'duplicate_template' };
    }
  }

  await contactRepo.updateSendStatus(contact.id, 'sending');

  const variables = buildVariables(contact);
  const providerName = messagingProvider.getName();

  const payload = {
    phone: contact.normalized_phone,
    templateName: campaign.template_name,
    language: campaign.template_language || 'pt_BR',
    variables,
    templateComponents: runtimeCtx?.templateComponents || [],
  };

  await messageLogRepo.create({
    campaignId: campaign.id,
    campaignContactId: contact.id,
    direction: 'outbound',
    provider: providerName,
    normalizedPhone: contact.normalized_phone,
    templateName: campaign.template_name,
    payload,
    status: 'queued',
  });

  let attempt = 0;
  while (attempt <= MAX_RATE_LIMIT_RETRIES) {
    try {
      const result = await messagingProvider.sendTemplateMessage(payload);

      await contactRepo.updateSendStatus(contact.id, 'sent', {
        sent_at: new Date(),
        error_message: null,
        failure_reason: null,
      });
      await campaignRepo.incrementCounter(campaign.id, 'total_sent');

      await messageLogRepo.create({
        campaignId: campaign.id,
        campaignContactId: contact.id,
        direction: 'outbound',
        provider: providerName,
        providerMessageId: result.messageId,
        normalizedPhone: contact.normalized_phone,
        templateName: campaign.template_name,
        payload,
        response: result.raw,
        status: 'sent',
        sentAt: new Date(),
      });

      await eventRepo.record({
        campaignId: campaign.id,
        eventType: 'contact_sent',
        eventMessage: `Mensagem enviada para ${contact.normalized_phone}`,
        metadata: {
          contactId: contact.id,
          providerMessageId: result.messageId,
          provider: providerName,
        },
      });

      return { success: true, messageId: result.messageId };
    } catch (err) {
      const errorMessage = err.message || 'Falha desconhecida';
      const isRateLimit = err.status === 429;

      // Back-off automático em rate limit
      if (isRateLimit && attempt < MAX_RATE_LIMIT_RETRIES) {
        const wait =
          (err.retryAfterSeconds && err.retryAfterSeconds > 0
            ? err.retryAfterSeconds
            : Math.min(60, 5 * Math.pow(2, attempt))) * 1000;
        await eventRepo.record({
          campaignId: campaign.id,
          eventType: 'rate_limited',
          eventMessage: `429 do provedor — aguardando ${wait}ms (tentativa ${attempt + 1}/${MAX_RATE_LIMIT_RETRIES}).`,
          metadata: { contactId: contact.id, retryAfterSeconds: err.retryAfterSeconds },
        });
        await sleep(wait);
        attempt += 1;
        continue;
      }

      const failureReason = classifyFailure(errorMessage, err.providerResponse);
      await contactRepo.updateSendStatus(contact.id, 'failed', {
        error_message: errorMessage,
        failure_reason: failureReason,
      });
      await campaignRepo.incrementCounter(campaign.id, 'total_failed');

      await messageLogRepo.create({
        campaignId: campaign.id,
        campaignContactId: contact.id,
        direction: 'outbound',
        provider: providerName,
        normalizedPhone: contact.normalized_phone,
        templateName: campaign.template_name,
        payload,
        response: err.providerResponse || null,
        status: 'failed',
        errorMessage,
      });

      await eventRepo.record({
        campaignId: campaign.id,
        eventType: 'contact_failed',
        eventMessage: `Falha ao enviar para ${contact.normalized_phone}: ${errorMessage}`,
        metadata: {
          contactId: contact.id,
          error: errorMessage,
          failureReason,
          provider: providerName,
        },
      });

      return { success: false, error: errorMessage, failureReason };
    }
  }

  return { success: false, error: 'Excedeu tentativas após rate limit' };
}

async function runCampaign(campaignId, options) {
  const controller = controllers.get(campaignId);
  if (!controller) return;

  try {
    const campaign = await campaignRepo.findById(campaignId);
    if (!campaign) {
      controller.error = 'Campanha não encontrada';
      return;
    }
    if (!campaign.template_name) {
      throw new Error('Campanha sem template definido.');
    }

    const requestedInterval =
      options.intervalSeconds ?? campaign.interval_seconds ?? 5;
    const intervalSeconds = Math.max(MIN_INTERVAL_SECONDS, requestedInterval);
    if (intervalSeconds !== requestedInterval) {
      await eventRepo.record({
        campaignId,
        eventType: 'interval_adjusted',
        eventMessage: `Intervalo ajustado de ${requestedInterval}s para ${intervalSeconds}s (mínimo permitido).`,
      });
    }
    const dailyLimit = options.dailyLimit ?? campaign.daily_limit ?? null;

    // Carrega os componentes do template apenas uma vez por campanha,
    // pra saber a ORDEM correta das variáveis (header / body) na Cloud API.
    let templateComponents = [];
    try {
      const templates = await whatsappClient.listTemplates();
      const found = templates.find(
        (t) =>
          t.name === campaign.template_name &&
          (!campaign.template_language || t.language === campaign.template_language)
      );
      if (found) templateComponents = found.components;
    } catch (e) {
      console.warn(
        `[campaignQueue] não foi possível listar templates para mapear vars: ${e.message}`
      );
    }
    const runtimeCtx = { templateComponents };

    const pending = await contactRepo.listValidPending(campaignId);

    let processable = pending;
    if (dailyLimit && dailyLimit > 0) {
      processable = pending.slice(0, dailyLimit);
    }

    // marca processáveis como queued
    for (const c of processable) {
      await contactRepo.updateSendStatus(c.id, 'queued');
    }

    await eventRepo.record({
      campaignId,
      eventType: 'campaign_started',
      eventMessage: `Iniciando envio para ${processable.length} contato(s) via ${messagingProvider.getName()}.`,
      metadata: {
        count: processable.length,
        intervalSeconds,
        dailyLimit,
        provider: messagingProvider.getName(),
      },
    });

    let processedCount = 0;
    for (const contact of processable) {
      // checa cancelamento
      if (controller.cancelled) break;

      // pausa cooperativa
      while (controller.paused && !controller.cancelled) {
        await sleep(500);
      }
      if (controller.cancelled) break;

      await processSingleContact(contact, campaign, runtimeCtx);
      processedCount += 1;

      const isLast = processedCount === processable.length;
      if (!isLast && intervalSeconds > 0 && !controller.cancelled) {
        // sleep cooperativo: divide em chunks pra acelerar cancelamento
        const totalMs = intervalSeconds * 1000;
        const stepMs = 250;
        let waited = 0;
        while (waited < totalMs && !controller.cancelled && !controller.paused) {
          await sleep(stepMs);
          waited += stepMs;
        }
      }
    }

    // resumo final
    const finalCampaign = await campaignRepo.refreshTotalsFromContacts(campaignId);
    let finalStatus;
    if (controller.cancelled) {
      finalStatus = 'cancelled';
      await contactRepo.cancelPending(campaignId);
    } else if (finalCampaign.total_failed === 0) {
      finalStatus = 'completed';
    } else if (finalCampaign.total_sent === 0) {
      finalStatus = 'failed';
    } else {
      finalStatus = 'completed_with_errors';
    }

    await campaignRepo.updateStatus(campaignId, finalStatus, {
      finished_at: new Date(),
    });
    await eventRepo.record({
      campaignId,
      eventType: controller.cancelled ? 'campaign_cancelled' : 'campaign_completed',
      eventMessage: `Status final: ${finalStatus}`,
      metadata: {
        total_sent: finalCampaign.total_sent,
        total_failed: finalCampaign.total_failed,
      },
    });
  } catch (err) {
    console.error(`[campaignQueue] erro na campanha ${campaignId}:`, err);
    await campaignRepo
      .updateStatus(campaignId, 'failed', { finished_at: new Date() })
      .catch(() => {});
    await eventRepo
      .record({
        campaignId,
        eventType: 'campaign_failed',
        eventMessage: err.message,
      })
      .catch(() => {});
  } finally {
    controllers.delete(campaignId);
  }
}

export async function start(campaignId, options = {}) {
  const existing = controllers.get(campaignId);
  if (existing && !existing.paused) {
    const err = new Error('Campanha já está em execução.');
    err.status = 409;
    throw err;
  }

  const campaign = await campaignRepo.findById(campaignId);
  if (!campaign) {
    const err = new Error('Campanha não encontrada.');
    err.status = 404;
    throw err;
  }
  if (!['ready', 'paused', 'completed_with_errors', 'failed'].includes(campaign.status)) {
    const err = new Error(
      `Campanha com status "${campaign.status}" não pode ser iniciada.`
    );
    err.status = 409;
    throw err;
  }

  // atualiza ajustes opcionais
  const extras = {};
  if (typeof options.intervalSeconds === 'number') extras.interval_seconds = options.intervalSeconds;
  if (typeof options.dailyLimit === 'number') extras.daily_limit = options.dailyLimit;
  if (Object.keys(extras).length || campaign.status !== 'sending') {
    await campaignRepo.updateStatus(
      campaignId,
      'sending',
      { ...extras, started_at: campaign.started_at || new Date() }
    );
  }

  const controller = { paused: false, cancelled: false };
  controllers.set(campaignId, controller);

  // dispara em background, sem bloquear a request
  runCampaign(campaignId, options).catch((err) => {
    console.error('[campaignQueue] runCampaign rejeitou:', err);
  });

  return { campaignId, status: 'sending' };
}

export async function pause(campaignId) {
  const controller = getController(campaignId);
  if (!controller) {
    const err = new Error('Campanha não está em execução.');
    err.status = 409;
    throw err;
  }
  controller.paused = true;
  await campaignRepo.updateStatus(campaignId, 'paused');
  await eventRepo.record({
    campaignId,
    eventType: 'campaign_paused',
    eventMessage: 'Campanha pausada pelo usuário.',
  });
  return { campaignId, status: 'paused' };
}

export async function cancel(campaignId) {
  const controller = getController(campaignId);
  if (controller) {
    controller.cancelled = true;
  } else {
    // não está em execução em memória — apenas atualiza no banco
    await campaignRepo.updateStatus(campaignId, 'cancelled', { finished_at: new Date() });
    await contactRepo.cancelPending(campaignId);
    await eventRepo.record({
      campaignId,
      eventType: 'campaign_cancelled',
      eventMessage: 'Campanha cancelada (não estava em execução).',
    });
  }
  return { campaignId, status: 'cancelling' };
}

export function isRunning(campaignId) {
  const c = controllers.get(campaignId);
  return Boolean(c && !c.cancelled);
}
