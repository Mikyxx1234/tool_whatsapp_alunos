import 'dotenv/config';
import { query } from '../db/client.js';
import { personNameFromRow } from '../utils/personName.js';

const matId = (await query('select id from matriculados_snapshots order by created_at desc limit 1')).rows[0].id;
const finId = (await query('select id from financeiro_snapshots order by created_at desc limit 1')).rows[0].id;

const name = 'ADRIANA DOS SANTOS ALMEIDA ALVES';
const mat = await query(
  `select data from matriculados_rows where snapshot_id=$1 and upper(trim(data->>'Nome'))=$2 limit 1`,
  [matId, name]
);
const fin = await query(
  `select data from financeiro_rows where snapshot_id=$1 and upper(trim(coalesce(data->>'Aluno', data->>'Nome','')))=$2 limit 1`,
  [finId, name]
);
console.log('mat', mat.rows[0]?.data);
console.log('fin', fin.rows[0]?.data);

process.exit(0);
