import 'dotenv/config';
import { excelSerialToDate, parseFlexibleDate } from '../utils/dateParser.js';
import { loadTerms, resolveLimbo } from '../services/termResolverService.js';
import { query } from '../db/client.js';

// 1) conversão de serial Excel
console.log('=== Excel serial → Date ===');
for (const s of [46112, 46046, 46036, 46200, 46400]) {
  const d = excelSerialToDate(s);
  console.log(`  ${s} → ${d?.toISOString().slice(0, 10)}`);
}

console.log('\n=== parseFlexibleDate variantes ===');
for (const v of ['46112', 46112, '2026-04-03', '03/04/2026', '46112.0']) {
  const d = parseFlexibleDate(v);
  console.log(`  "${v}" → ${d?.toISOString()}`);
}

console.log('\n=== Turmas cadastradas ===');
const terms = await loadTerms();
console.log(`total ativas: ${terms.length}`);
for (const t of terms) {
  console.log(
    `  ${t.codigo} | mat ${t.inicio_matricula}…${t.fim_matricula} | conteúdo ${t.inicio_conteudo}`
  );
}

console.log('\n=== Teste resolveLimbo para alguns serials ===');
const today = new Date();
console.log('hoje (ref):', today.toISOString().slice(0, 10));
for (const s of [46112, 46046, 46036, 46200, 46400]) {
  const r = resolveLimbo(terms, s, today);
  console.log(
    `  serial ${s} (${excelSerialToDate(s)?.toISOString().slice(0, 10)}) → ` +
      (r.term
        ? `turma=${r.term.codigo} limbo=${r.limbo} daysUntilStart=${r.daysUntilStart}`
        : 'sem turma cadastrada para essa data')
  );
}

console.log('\n=== Snapshot matriculados: distribuição de Data Matrícula ===');
const snap = (
  await query(
    `select id, file_name from matriculados_snapshots order by created_at desc limit 1`
  )
).rows[0];
if (snap) {
  const { rows } = await query(
    `select data->>'Data Matrícula' as dm, count(*)::int as c
       from matriculados_rows
      where snapshot_id = $1 and (data->>'Data Matrícula') is not null and (data->>'Data Matrícula') <> ''
      group by 1 order by c desc limit 12`,
    [snap.id]
  );
  for (const r of rows) {
    const d = parseFlexibleDate(r.dm);
    const iso = d?.toISOString().slice(0, 10) || '?';
    console.log(`  ${r.dm} → ${iso}  (${r.c} alunos)`);
  }
}

process.exit(0);
