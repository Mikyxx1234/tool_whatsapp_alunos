import 'dotenv/config';
import { query } from '../db/client.js';

const snapId = (
  await query('select id from matriculados_snapshots order by created_at desc limit 1')
).rows[0].id;

const { rows } = await query(`select data from matriculados_rows where snapshot_id = $1`, [snapId]);

const colHits = new Map();
for (const r of rows) {
  for (const [k, v] of Object.entries(r.data)) {
    const s = String(v ?? '').trim();
    if (/^49\d{6}$/.test(s)) {
      colHits.set(k, (colHits.get(k) || 0) + 1);
    }
  }
}
console.log('colunas com valor exato 49xxxxxx:', [...colHits.entries()].sort((a, b) => b[1] - a[1]));

const aline = await query(
  `select data from matriculados_rows where snapshot_id = $1
   and upper(data->>'Nome') like '%ALINE%BITENCOURT%'`,
  [snapId]
);
for (const r of aline.rows) {
  for (const [k, v] of Object.entries(r.data)) {
    if (/49/.test(String(v))) console.log('aline', k, v);
  }
}

process.exit(0);
