import 'dotenv/config';
import pg from 'pg';

const c = new pg.Client({ connectionString: process.env.DATABASE_URL });
await c.connect();

const u = await c.query(
  'select normalized_phone, message_text, message_type, created_at from whatsapp_inbound_unmatched order by created_at desc limit 5'
);
console.log('inbound_unmatched (últimos 5):');
u.rows.forEach((r) =>
  console.log(' -', r.normalized_phone, '|', r.message_text, '|', r.created_at)
);

const i = await c.query(
  'select campaign_id, normalized_phone, message_text, interacted_at from whatsapp_interactions order by interacted_at desc limit 5'
);
console.log('\nwhatsapp_interactions (últimos 5):');
i.rows.forEach((r) =>
  console.log(' -', r.normalized_phone, '|', r.message_text, '| campaign:', r.campaign_id)
);

const e = await c.query(
  `select event_type, event_message, created_at
     from whatsapp_campaign_events
     order by created_at desc
     limit 8`
);
console.log('\nwhatsapp_campaign_events (últimos 8):');
e.rows.forEach((r) =>
  console.log(' -', r.event_type, '|', r.event_message)
);

await c.end();
