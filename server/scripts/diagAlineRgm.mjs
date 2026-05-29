import 'dotenv/config';
import { query } from '../db/client.js';

const email = 'eucristinapease1014@gmail.com';
const rgms = ['49004816', '49016563', '13610210'];

for (const rgm of rgms) {
  const { rows } = await query(
    `select 'mat' as src, data->>'Aluno' as nome, data->>'RGM' as rgm
     from matriculados_rows where data->>'RGM' like $1 or data::text like $1 limit 3`,
    [`%${rgm}%`]
  );
  const fin = await query(
    `select 'fin' as src, data->>'Nome Aluno' as nome, data->>'Rgm' as rgm, data->>'RGM' as rgm2
     from financeiro_rows where data::text like $1 limit 3`,
    [`%${rgm}%`]
  );
  console.log('\nRGM', rgm, 'mat', rows.length, 'fin', fin.rows.length);
  console.log(rows, fin.rows);
}

const byEmail = await query(
  `select 'mat' t, data->>'RGM' rgm from matriculados_rows where lower(data->>'Email') = $1
   union all
   select 'fin', coalesce(data->>'Rgm', data->>'RGM') from financeiro_rows where lower(data->>'E-mail Alu') like $2 or lower(data->>'E-mail Aluno') like $2`,
  [email, `%${email.split('@')[0]}%`]
);
console.log('\nby email:', byEmail.rows);

const finName = await query(
  `select data from financeiro_rows
   where upper(coalesce(data->>'Nome Aluno', '')) like '%BITENCOURT%' limit 5`
);
console.log('\nfin bitencourt:', finName.rows.map((r) => ({
  nome: r.data['Nome Aluno'],
  rgm: r.data.Rgm ?? r.data.RGM,
  email: r.data['E-mail Alu'] ?? r.data['E-mail Aluno'],
})));

process.exit(0);
