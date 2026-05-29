import 'dotenv/config';
import { query } from '../db/client.js';

const { rows: snaps } = await query(
  `select id, file_name, row_count from processos_caa_snapshots order by created_at desc limit 1`
);
if (!snaps[0]) {
  console.log('sem snapshot CAA');
  process.exit(0);
}
const snap = snaps[0];
console.log('snapshot', snap.file_name, snap.row_count);

const { rows } = await query(
  `select data from processos_caa_rows where snapshot_id = $1 limit 8`,
  [snap.id]
);
const keys = new Set();
for (const r of rows) Object.keys(r.data || {}).forEach((k) => keys.add(k));
console.log('columns:', [...keys].sort().join(' | '));

for (const r of rows.slice(0, 3)) {
  console.log('---');
  console.log(JSON.stringify(r.data, null, 2));
}

const { rows: tipos } = await query(
  `select distinct trim(coalesce(
    data->>'Tipo', data->>'tipo', data->>'Tipo Processo', data->>'Tipo de Processo',
    data->>'Assunto', data->>'assunto', data->>'Serviço', data->>'Servico',
    data->>'Nome do Serviço', data->>'Categoria', ''
  )) as t, count(*)::int as n
   from processos_caa_rows where snapshot_id = $1
   group by 1 order by n desc limit 30`,
  [snap.id]
);
console.log('\nTop tipos/assuntos:');
for (const t of tipos) console.log(t.n, t.t || '(vazio)');

const { rows: subs } = await query(
  `select trim(coalesce(data->>'Subprocesso', '')) as sub, count(*)::int as n
     from processos_caa_rows where snapshot_id = $1
     group by 1 order by n desc`,
  [snap.id]
);
console.log('\nSubprocesso (todos):');
for (const s of subs) console.log(s.n, s.sub || '(vazio)');

const { rows: cancel } = await query(
  `select count(*)::int as n from processos_caa_rows
    where snapshot_id = $1
      and (
        lower(coalesce(data->>'Subprocesso','')) like '%cancel%'
        or lower(coalesce(data->>'Observação','')) like '%cancel%'
        or lower(coalesce(data->>'Observacao','')) like '%cancel%'
      )`,
  [snap.id]
);
console.log('\nLinhas com cancelamento no Subprocesso/Observação:', cancel[0].n);

const { rows: cancelSubs } = await query(
  `select trim(coalesce(data->>'Subprocesso', '')) as sub, count(*)::int as n
     from processos_caa_rows where snapshot_id = $1
       and lower(coalesce(data->>'Subprocesso','')) like '%cancel%'
     group by 1 order by n desc`,
  [snap.id]
);
console.log('\nSubprocessos com "cancel":');
for (const s of cancelSubs) console.log(s.n, s.sub);
