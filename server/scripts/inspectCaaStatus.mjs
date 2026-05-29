import 'dotenv/config';
import { query } from '../db/client.js';

const snap = (
  await query('select id, file_name, row_count, created_at from processos_caa_snapshots order by created_at desc limit 5')
).rows;
console.log('snapshots:', snap);

const latest = snap[0]?.id;
if (!latest) process.exit(0);

console.log('\n=== Situação Atendimento ===');
const att = await query(
  `select trim(coalesce(data->>'Situação Atendimento','')) as s, count(*)::int n
   from processos_caa_rows where snapshot_id = $1
   group by 1 order by n desc`,
  [latest]
);
console.log(att.rows);

console.log('\n=== Situação Deferimento ===');
const def = await query(
  `select trim(coalesce(data->>'Situação Deferimento','')) as s, count(*)::int n
   from processos_caa_rows where snapshot_id = $1
   group by 1 order by n desc`,
  [latest]
);
console.log(def.rows);

console.log('\n=== Atendimento x Deferimento ===');
const cross = await query(
  `select
     trim(coalesce(data->>'Situação Atendimento','')) as att,
     trim(coalesce(data->>'Situação Deferimento','')) as def,
     count(*)::int n
   from processos_caa_rows where snapshot_id = $1
   group by 1, 2 order by n desc limit 20`,
  [latest]
);
console.log(cross.rows);

console.log('\n=== amostra Pendente ===');
const pend = await query(
  `select data->>'Aluno' a, data->>'RGM' r, data->>'Protocolo' p,
          data->>'Data Chegada' chegada, data->>'Data Previsão' prev,
          data->>'Situação Atendimento' att, data->>'Situação Deferimento' def
   from processos_caa_rows where snapshot_id = $1
   and upper(coalesce(data->>'Situação Atendimento','')) like '%PEND%' limit 5`,
  [latest]
);
console.log(pend.rows);

console.log('\n=== amostra Cancelado ===');
const canc = await query(
  `select data->>'Aluno' a, data->>'RGM' r, data->>'Protocolo' p,
          data->>'Data Chegada' chegada, data->>'Data Conclusão' conc,
          data->>'Situação Atendimento' att, data->>'Situação Deferimento' def
   from processos_caa_rows where snapshot_id = $1
   and upper(coalesce(data->>'Situação Atendimento','')) like '%CANCEL%' limit 5`,
  [latest]
);
console.log(canc.rows);

console.log('\n=== unicidade Protocolo no snapshot ===');
const dup = await query(
  `select data->>'Protocolo' p, count(*)::int n
   from processos_caa_rows where snapshot_id = $1 and coalesce(data->>'Protocolo','') <> ''
   group by 1 having count(*) > 1 order by n desc limit 5`,
  [latest]
);
console.log('duplicados:', dup.rows);

const totalProt = await query(
  `select count(distinct data->>'Protocolo')::int distinct_prot, count(*)::int total
   from processos_caa_rows where snapshot_id = $1`,
  [latest]
);
console.log('totais:', totalProt.rows[0]);

const distinctRgm = await query(
  `select count(distinct data->>'RGM')::int distinct_rgm from processos_caa_rows where snapshot_id = $1`,
  [latest]
);
console.log('rgms distintos:', distinctRgm.rows[0]);

process.exit(0);
