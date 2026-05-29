import 'dotenv/config';
import { query } from '../db/client.js';

const snapId = (
  await query('select id from matriculados_snapshots order by created_at desc limit 1')
).rows[0].id;

const { rows } = await query(
  `select data from matriculados_rows where snapshot_id = $1
   and upper(coalesce(data->>'Nome','')) like '%ALINE%BITENCOURT%' limit 1`,
  [snapId]
);
const d = rows[0]?.data || {};
console.log('Mat Aline — campos com 6+ dígitos:');
for (const [k, v] of Object.entries(d)) {
  const s = String(v ?? '').trim();
  if (/\d{6,}/.test(s)) console.log(`  ${k}: ${s}`);
}

const keys = await query(
  `select distinct jsonb_object_keys(data) k from matriculados_rows where snapshot_id = $1`,
  [snapId]
);
console.log('\nTodas colunas mat:', keys.rows.map((r) => r.k).sort().join(', '));

const c49 = await query(
  `select count(*)::int c from matriculados_rows where snapshot_id = $1 and data::text like '%49004816%'`,
  [snapId]
);
console.log('\nlinhas com 49004816 anywhere:', c49.rows[0]);

process.exit(0);
