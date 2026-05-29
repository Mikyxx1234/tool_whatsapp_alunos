import 'dotenv/config';
import { query } from '../db/client.js';

const snap = (await query(
  `select id, file_name, row_count, created_at
     from acessos_blackboard_snapshots
     order by created_at desc limit 1`
)).rows[0];

if (!snap) {
  console.log('sem snapshot BB');
  process.exit(0);
}

console.log('snapshot:', snap.file_name, '| linhas:', snap.row_count, '| em:', snap.created_at);

const sample = (await query(
  `select data from acessos_blackboard_rows where snapshot_id = $1 limit 5`,
  [snap.id]
)).rows;

console.log('\n=== colunas ===');
if (sample[0]) {
  for (const k of Object.keys(sample[0].data || {})) console.log(' -', k);
}

console.log('\n=== 3 exemplos ===');
for (const r of sample.slice(0, 3)) console.log(JSON.stringify(r.data, null, 2), '\n---');

process.exit(0);
