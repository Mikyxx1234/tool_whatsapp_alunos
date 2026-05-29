import 'dotenv/config';
import { query } from '../db/client.js';

const r = await query(
  `select data->>'Rgm' as rgm, data->>'Nome Aluno' as nome
   from financeiro_rows where upper(coalesce(data->>'Nome Aluno','')) like '%ALINE%BITENCOURT%' limit 5`
);
console.log('aline fin:', r.rows);

const s = await query('select data from financeiro_rows limit 1');
console.log('keys:', Object.keys(s.rows[0]?.data || {}));

const r49 = await query(
  `select count(*)::int c from financeiro_rows where coalesce(data->>'Rgm','') like '49%'`
);
console.log('fin com prefixo 49:', r49.rows[0]);

process.exit(0);
