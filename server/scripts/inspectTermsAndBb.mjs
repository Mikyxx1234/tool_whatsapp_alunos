import 'dotenv/config';
import { query } from '../db/client.js';

const terms = (await query(`
  select codigo, nome, inicio_matricula, fim_matricula, inicio_conteudo, fim_conteudo, ativo
    from academic_terms order by inicio_conteudo nulls last, codigo
`)).rows;
console.log(`turmas cadastradas (${terms.length}):`);
for (const t of terms) {
  console.log(
    `  ${t.codigo.padEnd(15)} ${t.nome.padEnd(25)} mat=${t.inicio_matricula?.toISOString?.()?.slice(0,10) ?? '—'}→${t.fim_matricula?.toISOString?.()?.slice(0,10) ?? '—'}  conteudo=${t.inicio_conteudo?.toISOString?.()?.slice(0,10) ?? '—'}→${t.fim_conteudo?.toISOString?.()?.slice(0,10) ?? '—'}`
  );
}

const matSnap = (await query(
  `select id from matriculados_snapshots order by created_at desc limit 1`
)).rows[0]?.id;
if (!matSnap) {
  console.log('\nsem snapshot matriculados');
  process.exit(0);
}

console.log('\nciclos distintos em matriculados (top 20):');
const ciclos = await query(
  `select trim(coalesce(data->>'Ciclo','')) as c, count(*)::int n
     from matriculados_rows where snapshot_id = $1
     group by 1 order by n desc limit 20`,
  [matSnap]
);
for (const c of ciclos.rows) console.log(`  ${String(c.n).padStart(7)}  ${c.c || '(vazio)'}`);

console.log('\nciclos distintos em BB (top 20):');
const bbSnap = (await query(
  `select id from acessos_blackboard_snapshots order by created_at desc limit 1`
)).rows[0]?.id;
if (bbSnap) {
  const bb = await query(
    `select trim(coalesce(data->>'Ciclo','')) as c, count(*)::int n
       from acessos_blackboard_rows where snapshot_id = $1
       group by 1 order by n desc limit 20`,
    [bbSnap]
  );
  for (const c of bb.rows) console.log(`  ${String(c.n).padStart(7)}  ${c.c || '(vazio)'}`);
}

process.exit(0);
