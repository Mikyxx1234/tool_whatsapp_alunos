import { query } from '../db/client.js';

export async function create(interaction, client) {
  const exec = client ? client.query.bind(client) : query;
  const { rows } = await exec(
    `insert into whatsapp_interactions
       (campaign_id, campaign_contact_id, normalized_phone,
        message_text, message_type, provider_message_id,
        interacted_at, raw_payload)
     values ($1,$2,$3,$4,$5,$6,$7,$8)
     returning *`,
    [
      interaction.campaignId || null,
      interaction.campaignContactId || null,
      interaction.normalizedPhone,
      interaction.messageText || null,
      interaction.messageType || null,
      interaction.providerMessageId || null,
      interaction.interactedAt || new Date(),
      interaction.rawPayload ? JSON.stringify(interaction.rawPayload) : null,
    ]
  );
  return rows[0];
}

export async function saveUnmatched(payload, client) {
  const exec = client ? client.query.bind(client) : query;
  const { rows } = await exec(
    `insert into whatsapp_inbound_unmatched
       (normalized_phone, message_text, message_type, provider_message_id, raw_payload)
     values ($1,$2,$3,$4,$5)
     returning *`,
    [
      payload.normalizedPhone,
      payload.messageText || null,
      payload.messageType || null,
      payload.providerMessageId || null,
      payload.rawPayload ? JSON.stringify(payload.rawPayload) : null,
    ]
  );
  return rows[0];
}

export async function listByCampaign(campaignId, { limit = 200 } = {}) {
  const { rows } = await query(
    `select * from whatsapp_interactions
       where campaign_id = $1
       order by interacted_at desc
       limit $2`,
    [campaignId, limit]
  );
  return rows;
}
