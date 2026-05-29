import 'dotenv/config';
import { query } from '../db/client.js';

const mat = await query(`select count(*)::int c from matriculados_rows where data->>'RGM' like '49%'`);
const docs = await query(
  `select count(*)::int c from docs_pendentes_rows
   where snapshot_id = (select id from docs_pendentes_snapshots order by created_at desc limit 1)
   and data->>'Rgm' like '49%'`
);
console.log({ mat49: mat.rows[0], docs49: docs.rows[0] });
process.exit(0);
