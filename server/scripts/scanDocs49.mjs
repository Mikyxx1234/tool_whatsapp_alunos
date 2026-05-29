import 'dotenv/config';
import { query } from '../db/client.js';

const snapId = (
  await query('select id from docs_pendentes_snapshots order by created_at desc limit 1')
).rows[0].id;

const { rows } = await query(`select data from docs_pendentes_rows where snapshot_id = $1`, [snapId]);

let any49 = 0;
const colHits = new Map();
for (const r of rows) {
  const d = r.data;
  for (const [k, v] of Object.entries(d)) {
    const s = String(v ?? '').trim();
    if (/^49\d{6}$/.test(s)) {
      any49 += 1;
      colHits.set(k, (colHits.get(k) || 0) + 1);
    }
  }
}
console.log('linhas com algum campo 49xxxxxx:', any49);
console.log('colunas:', [...colHits.entries()]);

process.exit(0);
