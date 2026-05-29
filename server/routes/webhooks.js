import { Router } from 'express';
import { normalizeBrazilianPhone } from '../utils/phoneNormalizer.js';
import * as contactRepo from '../repositories/contactRepository.js';
import * as messageLogRepo from '../repositories/messageLogRepository.js';
import * as interactionRepo from '../repositories/interactionRepository.js';
import * as eventRepo from '../repositories/eventRepository.js';
import * as campaignRepo from '../repositories/campaignRepository.js';
import * as studentRepo from '../repositories/studentRepository.js';
import * as timelineRepo from '../repositories/timelineRepository.js';
import { classifyFailure } from '../utils/failureClassifier.js';
import { markStudentAccessed } from '../services/engagementService.js';

const router = Router();

/**
 * GET /api/webhooks/whatsapp
 * Verificação do webhook (usado tanto pela Meta quanto algumas integrações).
 *   ?hub.mode=subscribe&hub.verify_token=<TOKEN>&hub.challenge=<NUM>
 */
router.get('/whatsapp', (req, res) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];

  const expected = process.env.WEBHOOK_VERIFY_TOKEN;
  if (mode === 'subscribe' && token && expected && token === expected) {
    return res.status(200).send(String(challenge || ''));
  }
  return res.status(403).send('forbidden');
});

/**
 * Tenta extrair de um payload inbound (Meta Cloud API ou DataCrazy)
 * os dados mínimos: telefone, texto, tipo, providerMessageId.
 *
 * TODO [CURSOR]: confirmar formato exato da DataCrazy quando estiver disponível.
 */
function extractInbound(body) {
  const result = {
    phone: null,
    text: null,
    type: null,
    providerMessageId: null,
    matched: false,
  };

  if (!body || typeof body !== 'object') return result;

  // ---------- Meta Cloud API ----------
  // body.entry[].changes[].value.messages[]
  try {
    const change = body?.entry?.[0]?.changes?.[0];
    const value = change?.value;
    const message = value?.messages?.[0];
    if (message) {
      result.matched = true;
      result.phone = message.from || null;
      result.providerMessageId = message.id || null;
      result.type = message.type || null;
      if (message.type === 'text' && message.text?.body) {
        result.text = message.text.body;
      } else if (message.type === 'button' && message.button?.text) {
        result.text = message.button.text;
      } else if (message.type === 'interactive') {
        result.text =
          message.interactive?.button_reply?.title ||
          message.interactive?.list_reply?.title ||
          null;
      }
      return result;
    }
  } catch {
    /* ignore */
  }

  // ---------- DataCrazy / formato genérico ----------
  // Tentativas em vários campos comuns.
  result.phone = body.from || body.phone || body.sender || body.contact?.phone || null;
  result.text =
    body.text || body.message || body.body || body.content || body.message?.text || null;
  result.type = body.type || body.message_type || null;
  result.providerMessageId =
    body.id || body.messageId || body.message_id || body.provider_message_id || null;
  if (result.phone || result.text) result.matched = true;
  return result;
}

/**
 * POST /api/webhooks/whatsapp
 * Recebe mensagens inbound. Aceita o formato da Meta Cloud API e best-effort
 * para DataCrazy / outros provedores.
 */
router.post('/whatsapp', async (req, res) => {
  // responde rápido — a Meta pode reentregar se demorar
  res.status(200).json({ received: true });

  try {
    const body = req.body || {};

    // Status callbacks da Meta (delivered / read / failed) chegam em
    // body.entry[].changes[].value.statuses[]. Processa antes do inbound
    // pra distinguir falha-de-entrega de mensagem-recebida.
    const statuses =
      body?.entry?.[0]?.changes?.[0]?.value?.statuses;
    if (Array.isArray(statuses) && statuses.length > 0) {
      for (const st of statuses) {
        await processStatusCallback(st, body);
      }
      return;
    }

    const extracted = extractInbound(body);
    if (!extracted.phone) {
      console.warn('[webhook] payload sem telefone identificável:', JSON.stringify(body).slice(0, 500));
      return;
    }

    const norm = normalizeBrazilianPhone(extracted.phone);
    const normalizedPhone = norm.ok ? norm.phone : extracted.phone.replace(/\D+/g, '');

    // Régua Inteligente: tenta achar aluno e registra timeline + cancela eventos
    // futuros pendentes (paralelo ao tratamento da campanha manual abaixo).
    try {
      const student = await studentRepo.findByPhone(normalizedPhone);
      if (student) {
        await timelineRepo.record({
          studentId: student.id,
          eventType: 'interaction_received',
          title: 'Resposta recebida do aluno',
          description: extracted.text
            ? extracted.text.slice(0, 200)
            : `Tipo de mensagem: ${extracted.type || 'desconhecido'}`,
          metadata: {
            messageType: extracted.type,
            providerMessageId: extracted.providerMessageId,
          },
        }).catch(() => {});

        // Resposta válida -> aluno engajou; marca como acessado e cancela eventos futuros
        await markStudentAccessed(student.id).catch((err) => {
          console.warn('[webhook] markStudentAccessed falhou:', err.message);
        });
      }
    } catch (err) {
      console.warn('[webhook] integração régua falhou:', err.message);
    }

    const matchWindowHours = Number(process.env.WEBHOOK_MATCH_WINDOW_HOURS) || 168;
    const contact = await contactRepo.findLatestByPhone(normalizedPhone, matchWindowHours);

    if (contact) {
      const now = new Date();

      await messageLogRepo.create({
        campaignId: contact.campaign_id,
        campaignContactId: contact.id,
        direction: 'inbound',
        provider: 'webhook',
        providerMessageId: extracted.providerMessageId,
        normalizedPhone,
        payload: body,
        status: 'received',
        receivedAt: now,
      });

      await interactionRepo.create({
        campaignId: contact.campaign_id,
        campaignContactId: contact.id,
        normalizedPhone,
        messageText: extracted.text,
        messageType: extracted.type,
        providerMessageId: extracted.providerMessageId,
        interactedAt: now,
        rawPayload: body,
      });

      const wasUnknown = contact.interaction_status === 'unknown';
      await contactRepo.markInteracted(contact.id, now);
      if (wasUnknown) {
        await campaignRepo.incrementCounter(contact.campaign_id, 'total_interacted');
      }

      await eventRepo.record({
        campaignId: contact.campaign_id,
        eventType: 'interaction_received',
        eventMessage: `Interação recebida de ${normalizedPhone}`,
        metadata: {
          contactId: contact.id,
          messageType: extracted.type,
          excerpt: (extracted.text || '').slice(0, 120),
        },
      });
    } else {
      // Sem campanha correlata — guarda em separado para auditoria.
      await interactionRepo.saveUnmatched({
        normalizedPhone,
        messageText: extracted.text,
        messageType: extracted.type,
        providerMessageId: extracted.providerMessageId,
        rawPayload: body,
      });
      await messageLogRepo.create({
        direction: 'inbound',
        provider: 'webhook',
        providerMessageId: extracted.providerMessageId,
        normalizedPhone,
        payload: body,
        status: 'received_unmatched',
        receivedAt: new Date(),
      });
    }
  } catch (err) {
    console.error('[webhook] erro processando inbound:', err);
  }
});

/**
 * Processa um item de body.entry[].changes[].value.statuses[] da Meta Cloud API.
 *
 * Estrutura típica:
 * {
 *   id: "wamid.HBg...",
 *   status: "sent" | "delivered" | "read" | "failed",
 *   timestamp: "1700000000",
 *   recipient_id: "5511999999999",
 *   errors: [{ code: 131026, title: "Message Undeliverable", ... }]
 * }
 *
 * Quando `status === 'failed'` e o erro for "Message Undeliverable",
 * marcamos o contato como `failed / not_on_whatsapp` mesmo que o envio
 * tenha sido inicialmente aceito (200 OK) pela API.
 */
async function processStatusCallback(status, fullPayload) {
  try {
    const wamid = status.id;
    const statusName = String(status.status || '').toLowerCase();
    const recipient = status.recipient_id;
    const errors = Array.isArray(status.errors) ? status.errors : [];

    if (!wamid && !recipient) return;

    const log = wamid
      ? await messageLogRepo.findOutboundByProviderId(wamid)
      : null;

    const contactId = log?.campaign_contact_id || null;
    const campaignId = log?.campaign_id || null;
    const normalizedPhone =
      log?.normalized_phone ||
      (recipient ? recipient.replace(/\D+/g, '') : null);

    // Sempre persistimos o evento de status pra auditoria
    await messageLogRepo.create({
      campaignId,
      campaignContactId: contactId,
      direction: 'inbound',
      provider: 'meta-status',
      providerMessageId: wamid,
      normalizedPhone,
      payload: fullPayload,
      response: status,
      status: `status:${statusName}`,
      receivedAt: new Date(),
    });

    if (!contactId) return;

    if (statusName === 'failed') {
      const primary = errors[0] || {};
      const errorMessage =
        primary.error_data?.details ||
        primary.title ||
        primary.message ||
        'Message Undeliverable';
      const failureReason = classifyFailure(
        `${primary.title || ''} ${errorMessage} ${primary.code || ''}`,
        { error: primary }
      );

      const contact = await contactRepo.findById(contactId);
      const wasAlreadyCounted =
        contact && contact.send_status === 'sent';

      await contactRepo.updateSendStatus(contactId, 'failed', {
        error_message: errorMessage,
        failure_reason: failureReason,
      });

      // Se contava como sent, devolvemos o contador
      if (wasAlreadyCounted) {
        await campaignRepo.incrementCounter(campaignId, 'total_sent', -1);
      }
      await campaignRepo.incrementCounter(campaignId, 'total_failed');

      await eventRepo.record({
        campaignId,
        eventType: 'delivery_failed',
        eventMessage: `Entrega falhou (Meta status callback): ${errorMessage}`,
        metadata: {
          contactId,
          wamid,
          failureReason,
          errorCode: primary.code,
        },
      });
      return;
    }

    if (statusName === 'delivered' || statusName === 'read') {
      const when = new Date(
        Number(status.timestamp) ? Number(status.timestamp) * 1000 : Date.now()
      );
      const extras =
        statusName === 'delivered'
          ? { delivered_at: when }
          : { read_at: when };
      await contactRepo.updateSendStatus(contactId, 'sent', extras);
    }
  } catch (err) {
    console.error('[webhook] erro processando status callback:', err);
  }
}

export default router;
