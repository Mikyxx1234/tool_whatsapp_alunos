import 'dotenv/config';
import { query } from '../server/db/client.js';

const { rows: campaigns } = await query(
  `select id, name, status, total_valid, total_sent, total_failed, template_name, created_at
     from whatsapp_campaigns
     order by created_at desc
     limit 3`
);
console.log('--- últimas campanhas ---');
console.table(campaigns);

if (campaigns[0]) {
  const cid = campaigns[0].id;
  const { rows: contacts } = await query(
    `select normalized_phone, validation_status, send_status, failure_reason, error_message
       from whatsapp_campaign_contacts
       where campaign_id = $1
       order by created_at asc`,
    [cid]
  );
  console.log(`--- contatos da campanha ${cid} ---`);
  console.table(contacts);

  const { rows: logs } = await query(
    `select direction, status, error_message, payload, response, created_at
       from whatsapp_message_logs
       where campaign_id = $1
       order by created_at asc
       limit 10`,
    [cid]
  );
  console.log(`--- logs ---`);
  for (const l of logs) {
    console.log({
      direction: l.direction,
      status: l.status,
      error_message: l.error_message,
      payload: l.payload,
      response: l.response,
    });
  }

  const { rows: events } = await query(
    `select event_type, event_message, metadata, created_at
       from whatsapp_campaign_events
       where campaign_id = $1
       order by created_at asc`,
    [cid]
  );
  console.log(`--- eventos ---`);
  console.table(events);
}

process.exit(0);
