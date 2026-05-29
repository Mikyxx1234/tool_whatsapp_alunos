import 'dotenv/config';
import { query } from '../db/client.js';

const cnt = await query(
  `select status, count(*)::int n from caa_protocols group by status order by n desc`
);
console.log('estado atual:', cnt.rows);

const opens = await query(
  `select protocolo, rgm, nome, last_seen_at, last_status_change_at, last_snapshot_id
     from caa_protocols where status = 'open' order by last_status_change_at desc`
);
console.log('\nopen rows:', opens.rows);

const latestSnap = (
  await query('select id from processos_caa_snapshots order by created_at desc limit 1')
).rows[0]?.id;
console.log('\nlatest snap', latestSnap);

const openLatest = await query(
  `select protocolo, rgm from caa_protocols
     where status = 'open' and last_snapshot_id = $1`,
  [latestSnap]
);
console.log('open no snapshot mais recente:', openLatest.rows);

const transitions = await query(
  `select to_status, count(*)::int n from caa_protocol_transitions group by to_status order by n desc`
);
console.log('\ntransições por status destino:', transitions.rows);

const transDetails = await query(
  `select protocolo, rgm, from_status, to_status, changed_at::text
     from caa_protocol_transitions
     where from_status is not null
     order by changed_at desc limit 20`
);
console.log('\núltimas transições (real):', transDetails.rows);

process.exit(0);
