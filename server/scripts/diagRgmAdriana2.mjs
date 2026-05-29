import 'dotenv/config';
import { query } from '../db/client.js';

const finId = (await query('select id from financeiro_snapshots order by created_at desc limit 1')).rows[0].id;
const fin = await query(
  `select data->>'RGM' rgm, data->>'Aluno' aluno from financeiro_rows where snapshot_id=$1 and upper(data->>'Aluno') like '%ADRIANA DOS SANTOS%' limit 3`,
  [finId]
);
console.log(fin.rows);

process.exit(0);
