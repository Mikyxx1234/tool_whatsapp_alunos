import 'dotenv/config';
import { query } from '../db/client.js';

const matId = (await query('select id from matriculados_snapshots order by created_at desc limit 1')).rows[0].id;

const formats = await query(`
  select
    count(*)::int as total,
    count(*) filter (where coalesce(data->>'RGM','') ~ '^\\+')::int as com_mais,
    count(*) filter (where coalesce(data->>'RGM','') ~ '^[0-9]{7,9}$')::int as so_numeros,
    count(*) filter (where length(regexp_replace(coalesce(data->>'RGM',''), '[^0-9]', '', 'g')) between 7 and 9)::int as digitos_7_9
  from matriculados_rows where snapshot_id = $1
`, [matId]);
console.log('mat RGM formats', formats.rows[0]);

const evId = (await query('select id from provavel_evasao_snapshots order by created_at desc limit 1')).rows[0].id;
const evFmt = await query(`
  select count(*)::int total,
    count(*) filter (where coalesce(data->>'RGM','') ~ '^[0-9]+$')::int as so_numeros
  from provavel_evasao_rows where snapshot_id = $1
`, [evId]);
console.log('ev RGM formats', evFmt.rows[0]);

// try match by nome + polo (dangerous) - sample
const hitNome = await query(`
  select count(*)::int n from provavel_evasao_rows e
  where e.snapshot_id = $2
  and exists (
    select 1 from matriculados_rows m
    where m.snapshot_id = $1
    and upper(trim(m.data->>'Nome')) = upper(trim(e.data->>'Aluno'))
  )
`, [matId, evId]);
console.log('match exato por nome:', hitNome.rows[0].n);

process.exit(0);
