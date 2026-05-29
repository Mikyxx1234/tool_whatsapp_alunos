import 'dotenv/config';
import { query } from '../db/client.js';

const snapId = (
  await query('select id from financeiro_snapshots order by created_at desc limit 1')
).rows[0].id;

const aline = await query(
  `select data from financeiro_rows where snapshot_id = $1
   and (upper(coalesce(data->>'Aluno','')) like '%ALINE%BITENCOURT%'
        or upper(coalesce(data->>'Nome Aluno','')) like '%ALINE%BITENCOURT%'
        or lower(coalesce(data->>'Email','')) like '%eucristina%') limit 3`,
  [snapId]
);
console.log('Aline financeiro:', aline.rows.map((r) => r.data));

const s49 = await query(
  `select data->>'RGM' rgm, data->>'Rgm' rgm2, data->>'Aluno' a, data->>'Nome Aluno' n
   from financeiro_rows where snapshot_id = $1
   and (coalesce(data->>'RGM','') like '49%' or coalesce(data->>'Rgm','') like '49%') limit 5`,
  [snapId]
);
console.log('amostra 49:', s49.rows);

const keys = await query(
  `select distinct jsonb_object_keys(data) k from financeiro_rows where snapshot_id = $1 limit 20`,
  [snapId]
);
console.log('cols:', keys.rows.map((r) => r.k));

process.exit(0);
