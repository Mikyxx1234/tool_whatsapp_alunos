import 'dotenv/config';
import { query } from '../db/client.js';

const finId = (await query('select id from financeiro_snapshots order by created_at desc limit 1')).rows[0].id;
const { rows } = await query('select data from financeiro_rows where snapshot_id = $1 limit 3', [finId]);
for (const r of rows) console.log(r.data);

process.exit(0);
