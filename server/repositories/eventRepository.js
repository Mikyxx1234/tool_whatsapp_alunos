import { query } from '../db/client.js';

export async function record(event, client) {
  const exec = client ? client.query.bind(client) : query;
  const { rows } = await exec(
    `insert into whatsapp_campaign_events
       (campaign_id, event_type, event_message, metadata)
     values ($1,$2,$3,$4)
     returning *`,
    [
      event.campaignId || null,
      event.eventType,
      event.eventMessage || null,
      event.metadata ? JSON.stringify(event.metadata) : null,
    ]
  );
  return rows[0];
}

export async function listByCampaign(campaignId, { limit = 100 } = {}) {
  const { rows } = await query(
    `select * from whatsapp_campaign_events
       where campaign_id = $1
       order by created_at desc
       limit $2`,
    [campaignId, limit]
  );
  return rows;
}
