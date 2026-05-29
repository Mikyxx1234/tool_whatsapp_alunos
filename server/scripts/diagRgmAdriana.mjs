import 'dotenv/config';
import { query } from '../db/client.js';

const matId = (await query('select id from matriculados_snapshots order by created_at desc limit 1')).rows[0].id;
const finId = (await query('select id from financeiro_snapshots order by created_at desc limit 1')).rows[0].id;

const email = 'almeida.adriana196@gmail.com';
const fin = await query(
  `select data->>'RGM' rgm, data->>'Aluno' aluno from financeiro_rows where snapshot_id=$1 and lower(trim(data->>'Email'))=$2`,
  [finId, email]
);
console.log('fin by email', fin.rows);

const mat = await query(
  `select data->>'RGM' rgm from matriculados_rows where snapshot_id=$1 and lower(trim(data->>'Email'))=$2`,
  [matId, email]
);
console.log('mat by email', mat.rows);

process.exit(0);
