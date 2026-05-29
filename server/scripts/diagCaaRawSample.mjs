import '../boot-env.js';
import { query } from '../db/client.js';

const snapId = '88d11047-52e9-4984-a901-853f1ad74193';

const { rows: cols } = await query(
  `select distinct jsonb_object_keys(data) as col
     from processos_caa_rows
    where snapshot_id = $1
    order by col`,
  [snapId]
);
console.log('=== colunas distintas no snapshot ===');
for (const c of cols) console.log(' -', c.col);

const { rows: counts } = await query(
  `select
     count(*) filter (where coalesce(data->>'Subprocesso','') ilike '%cancelamento%matr%')::int as cancel_mat,
     count(*) filter (where coalesce(data->>'Situação Atendimento','') ilike '%PEND%')::int as pendentes_geral,
     count(*) filter (where coalesce(data->>'Subprocesso','') ilike '%cancelamento%matr%'
                       and coalesce(data->>'Situação Atendimento','') ilike '%PEND%')::int as cancel_mat_pend,
     count(*)::int as total
     from processos_caa_rows
    where snapshot_id = $1`,
  [snapId]
);
console.log('\n=== contagens ===', counts[0]);

const { rows: subprocessos } = await query(
  `select coalesce(data->>'Subprocesso','(vazio)') as sp, count(*)::int as n
     from processos_caa_rows
    where snapshot_id = $1
    group by sp
    order by n desc`,
  [snapId]
);
console.log('\n=== distintos de Subprocesso ===');
for (const r of subprocessos) console.log(`  ${r.n}\t${r.sp}`);

const { rows: situacoes } = await query(
  `select coalesce(data->>'Situação Atendimento','(vazio)') as att, count(*)::int as n
     from processos_caa_rows
    where snapshot_id = $1
    group by att
    order by n desc`,
  [snapId]
);
console.log('\n=== distintos de Situação Atendimento ===');
for (const r of situacoes) console.log(`  ${r.n}\t${r.att}`);

const { rows: sample } = await query(
  `select data
     from processos_caa_rows
    where snapshot_id = $1
    limit 3`,
  [snapId]
);
console.log('\n=== 3 linhas amostra ===');
for (const r of sample) {
  console.log(JSON.stringify(r.data, null, 2));
  console.log('---');
}

process.exit(0);
