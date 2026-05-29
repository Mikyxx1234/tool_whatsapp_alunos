import 'dotenv/config';
import { query } from '../db/client.js';

const fin = (await query('select id from financeiro_snapshots order by created_at desc limit 1')).rows[0];
const mat = (await query('select id from matriculados_snapshots order by created_at desc limit 1')).rows[0];

for (const [label, id, table] of [
  ['fin', fin?.id, 'financeiro_rows'],
  ['mat', mat?.id, 'matriculados_rows'],
]) {
  const { rows } = await query(
    `select data->>'RGM' rgm, data->>'Nome' nome, data->>'Aluno' aluno from ${table} where snapshot_id = $1 limit 5`,
    [id]
  );
  console.log('---', label);
  console.log(rows);
}

process.exit(0);
