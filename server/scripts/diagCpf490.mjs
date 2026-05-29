import 'dotenv/config';
import { query } from '../db/client.js';

const cpf = '39756956844';
for (const t of ['matriculados_rows', 'docs_pendentes_rows']) {
  const r = await query(
    `select data from ${t} where data::text like $1 limit 3`,
    [`%${cpf}%`]
  );
  console.log(t, r.rows.map((x) => x.data));
}
process.exit(0);
