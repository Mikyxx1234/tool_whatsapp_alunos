import 'dotenv/config';
import { query } from '../db/client.js';

const snapId = (
  await query('select id from docs_pendentes_snapshots order by created_at desc limit 1')
).rows[0].id;

const { rows } = await query(
  `select data from docs_pendentes_rows where snapshot_id = $1
   and upper(data->>'Nome Aluno') like '%ALINE%BITENCOURT%' limit 1`,
  [snapId]
);
const d = rows[0]?.data || {};
console.log('Aline full row keys/values with digits:');
for (const [k, v] of Object.entries(d)) {
  const s = String(v ?? '');
  if (/\d{6,}/.test(s)) console.log(`  ${k}: ${s}`);
}

const with49 = await query(
  `select data->>'Nome Aluno' nome, data->>'Rgm' rgm
   from docs_pendentes_rows where snapshot_id = $1 and data::text like '%49004%' limit 5`,
  [snapId]
);
console.log('\nrows containing 49004 in json:', with49.rows);

process.exit(0);
