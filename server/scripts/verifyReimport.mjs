import 'dotenv/config';
import { query } from '../db/client.js';

const tables = [
  ['matriculados', 'matriculados_snapshots', 'matriculados_rows', 'RGM'],
  ['docs-pendentes', 'docs_pendentes_snapshots', 'docs_pendentes_rows', 'Rgm'],
  ['financeiro', 'financeiro_snapshots', 'financeiro_rows', 'RGM'],
];

for (const [cat, st, rt, col] of tables) {
  const snaps = await query(
    `select id, file_name, row_count, created_at from ${st} order by created_at desc limit 3`
  );
  const latest = snaps.rows[0];
  if (!latest) {
    console.log(`\n${cat}: sem snapshot`);
    continue;
  }
  const prefix49 = await query(
    `select count(*)::int c from ${rt} where snapshot_id = $1 and data->>'${col}' like '49%'`,
    [latest.id]
  );
  const prefix13 = await query(
    `select count(*)::int c from ${rt} where snapshot_id = $1 and data->>'${col}' like '13%'`,
    [latest.id]
  );
  const erp = await query(
    `select count(*)::int c from ${rt} where snapshot_id = $1 and coalesce(data->>'RGM_erp_matricula','') <> ''`,
    [latest.id]
  );
  console.log(`\n=== ${cat} ===`);
  console.log('últimos snapshots:', snaps.rows);
  console.log(`col ${col}: prefixo 49=${prefix49.rows[0].c}, prefixo 13=${prefix13.rows[0].c}, erp_mat=${erp.rows[0]?.c ?? 'n/a'}`);
}

const snapDocs = (
  await query('select id from docs_pendentes_snapshots order by created_at desc limit 1')
).rows[0]?.id;
const aline = await query(
  `select data->>'Rgm' rgm, data->>'Nome Aluno' nome, data->>'RGM_erp_matricula' erp
   from docs_pendentes_rows where snapshot_id = $1
   and upper(data->>'Nome Aluno') like '%ALINE%BITENCOURT%' limit 2`,
  [snapDocs]
);
console.log('\nAline docs:', aline.rows);

const snapMat = (
  await query('select id from matriculados_snapshots order by created_at desc limit 1')
).rows[0]?.id;
const alineMat = await query(
  `select data->>'RGM' rgm, data->>'Nome' nome, data->>'RGM_erp_matricula' erp, data->>'Email' email
   from matriculados_rows where snapshot_id = $1
   and upper(coalesce(data->>'Nome','')) like '%ALINE%BITENCOURT%' limit 2`,
  [snapMat]
);
console.log('Aline mat:', alineMat.rows);

const r490 = await query(
  `select count(*)::int c from docs_pendentes_rows where snapshot_id = $1 and data->>'Rgm' = '49004816'`,
  [snapDocs]
);
console.log('docs com Rgm 49004816:', r490.rows[0]);

process.exit(0);
