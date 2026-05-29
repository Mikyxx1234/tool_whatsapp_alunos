import 'dotenv/config';
import { query } from '../db/client.js';

const finId = (await query('select id from financeiro_snapshots order by created_at desc limit 1')).rows[0].id;
const r = await query(
  `select data from financeiro_rows where snapshot_id=$1 and upper(data->>'Aluno') like '%ALMEIDA ALVES%'`,
  [finId]
);
console.log(r.rows.map((x) => ({ aluno: x.data.Aluno, rgm: x.data.RGM, email: x.data.Email })));

process.exit(0);
