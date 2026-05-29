import 'dotenv/config';
import { query } from '../db/client.js';

const snapId = (
  await query('select id from matriculados_snapshots order by created_at desc limit 1')
).rows[0].id;

const { rows } = await query(
  `select data from matriculados_rows where snapshot_id = $1 limit 500`,
  [snapId]
);

const colHits = new Map();
for (const r of rows) {
  for (const [k, v] of Object.entries(r.data)) {
    const s = String(v ?? '').trim();
    if (/^4[89]\d{6}$/.test(s) || /^48\d{6}$/.test(s) || /^49\d{6}$/.test(s)) {
      colHits.set(k, (colHits.get(k) || 0) + 1);
    }
  }
}
console.log('amostra 500 linhas — colunas com RGM institucional 48/49:', [...colHits.entries()]);

const { rows: all } = await query(
  `select count(*)::int c from matriculados_rows where snapshot_id = $1 and data::text ~ '49[0-9]{6}'`,
  [snapId]
);
console.log('total linhas json com 49xxxxxx:', all[0]);

process.exit(0);
