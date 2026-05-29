import 'dotenv/config';
import { query } from '../db/client.js';

const { rows: s } = await query(
  'select id from provavel_evasao_snapshots order by created_at desc limit 1'
);
const { rows } = await query(
  'select data from provavel_evasao_rows where snapshot_id = $1 limit 2',
  [s[0].id]
);
console.log(JSON.stringify(rows[0].data, null, 2));

process.exit(0);
