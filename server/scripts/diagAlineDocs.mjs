import 'dotenv/config';
import { query } from '../db/client.js';

const snapId = (
  await query('select id from docs_pendentes_snapshots order by created_at desc limit 1')
).rows[0].id;
console.log('latest docs snap', snapId);

const keys = await query(
  `select distinct jsonb_object_keys(data) k from docs_pendentes_rows where snapshot_id = $1 limit 30`,
  [snapId]
);
console.log('cols:', keys.rows.map((r) => r.k));

const aline = await query(
  `select data from docs_pendentes_rows
   where snapshot_id = $1
   and (data::text ilike '%aline%bitencourt%' or data::text ilike '%49004816%')`,
  [snapId]
);
console.log('aline/49004816 rows:', aline.rows.length);
for (const r of aline.rows) console.log(r.data);

const r49 = await query(
  `select count(*)::int c from docs_pendentes_rows
   where snapshot_id = $1 and data::text like '%49%'`,
  [snapId]
);
console.log('rows with 49 in json:', r49.rows[0]);

const sample = await query(
  `select data from docs_pendentes_rows where snapshot_id = $1 limit 2`,
  [snapId]
);
console.log('sample:', sample.rows);

process.exit(0);
