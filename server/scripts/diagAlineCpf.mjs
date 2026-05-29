import 'dotenv/config';
import { query } from '../db/client.js';

const cpf = '41679106830';
for (const t of ['matriculados_rows', 'financeiro_rows', 'docs_pendentes_rows']) {
  const { rows } = await query(
    `select data->>'RGM' rgm, data->>'Rgm' rgm2, data->>'Aluno' a, data->>'Nome Aluno' n
     from ${t} where regexp_replace(coalesce(data->>'CPF', data->>'Cpf Aluno', ''), '[^0-9]', '', 'g') = $1 limit 3`,
    [cpf]
  );
  console.log(t, rows);
}
process.exit(0);
