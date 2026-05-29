import 'dotenv/config';
import { query } from '../db/client.js';

const { rows: s } = await query(
  'select id from matriculados_snapshots order by created_at desc limit 1'
);
const { rows } = await query(
  'select data from matriculados_rows where snapshot_id = $1 limit 3',
  [s[0].id]
);
for (const r of rows) {
  console.log('keys:', Object.keys(r.data).sort().join(' | '));
  console.log(JSON.stringify(r.data, null, 2));
  console.log('---');
}

process.exit(0);
