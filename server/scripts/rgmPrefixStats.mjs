import 'dotenv/config';
import { query } from '../db/client.js';

const r = await query(`
  select left(data->>'RGM', 2) as p, count(*)::int as c
  from matriculados_rows
  where data->>'RGM' ~ '^[0-9]{8}$'
  group by 1 order by c desc limit 20
`);
console.log('prefixos mat 8dig:', r.rows);

const fin = await query(`
  select left(coalesce(data->>'Rgm', data->>'RGM'), 2) as p, count(*)::int as c
  from financeiro_rows
  where coalesce(data->>'Rgm', data->>'RGM') ~ '^[0-9]{8}$'
  group by 1 order by c desc limit 10
`);
console.log('prefixos fin 8dig:', fin.rows);

process.exit(0);
