import 'dotenv/config';
import { query } from '../db/client.js';

const mat = await query(
  "select data->>'RGM' as rgm from matriculados_rows where data->>'RGM' is not null limit 5"
);
console.log('mat amostra:', mat.rows);

const bad = await query(
  "select count(*)::int as c from matriculados_rows where data->>'RGM' ~ '[+.-]'"
);
console.log('mat com + ou ponto:', bad.rows[0]);

const finBad = await query(
  "select count(*)::int as c from financeiro_rows where data->>'RGM' !~ '^[0-9]{8}$' and coalesce(data->>'RGM','') <> ''"
);
console.log('financeiro fora do padrao 8 digitos:', finBad.rows[0]);

const finOdd = await query(
  "select distinct data->>'RGM' as rgm from financeiro_rows where data->>'RGM' !~ '^[0-9]{8}$' and coalesce(data->>'RGM','') <> '' limit 10"
);
console.log('financeiro exemplos fora:', finOdd.rows);

process.exit(0);
