import { query } from '../db/client.js';

export async function create(log, client) {
  const exec = client ? client.query.bind(client) : query;
  const { rows } = await exec(
    `insert into whatsapp_message_logs
       (campaign_id, campaign_contact_id, direction, provider,
        provider_message_id, normalized_phone, template_name,
        payload, response, status, error_message, sent_at, received_at)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
     returning *`,
    [
      log.campaignId || null,
      log.campaignContactId || null,
      log.direction,
      log.provider || 'datacrazy',
      log.providerMessageId || null,
      log.normalizedPhone || null,
      log.templateName || null,
      log.payload ? JSON.stringify(log.payload) : null,
      log.response ? JSON.stringify(log.response) : null,
      log.status || null,
      log.errorMessage || null,
      log.sentAt || null,
      log.receivedAt || null,
    ]
  );
  return rows[0];
}

/**
 * Encontra o log outbound correspondente a um provider_message_id (wamid).
 * Usado pelo webhook handler ao receber um status callback (delivered/failed).
 */
export async function findOutboundByProviderId(providerMessageId) {
  if (!providerMessageId) return null;
  const { rows } = await query(
    `select * from whatsapp_message_logs
       where provider_message_id = $1 and direction = 'outbound'
       order by created_at desc
       limit 1`,
    [providerMessageId]
  );
  return rows[0] || null;
}

export async function listByContact(contactId, { limit = 50 } = {}) {
  const { rows } = await query(
    `select * from whatsapp_message_logs
       where campaign_contact_id = $1
       order by created_at desc
       limit $2`,
    [contactId, limit]
  );
  return rows;
}
