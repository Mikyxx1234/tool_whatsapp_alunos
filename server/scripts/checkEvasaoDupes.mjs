import 'dotenv/config';
import { query } from '../db/client.js';

const total = await query('select count(*)::int as n from provavel_evasao_rows');
console.log('total rows', total.rows[0].n);

const dup = await query(`
  select count(*)::int as rgms_com_dup
  from (
    select data->>'RGM' as rgm
    from provavel_evasao_rows
    group by 1
    having count(*) > 1
  ) t
`);
console.log('RGMs com mais de 1 linha', dup.rows[0].rgms_com_dup);

const snap = await query(
  'select id, file_name, row_count from provavel_evasao_snapshots order by created_at desc limit 1'
);
console.log('latest snapshot', snap.rows[0] || 'none');

process.exit(0);
