import 'dotenv/config';
import { query } from '../db/client.js';
import * as XLSX from 'xlsx';
import fs from 'fs';
import path from 'path';

const snapId = (
  await query('select id, created_at from financeiro_snapshots order by created_at desc limit 1')
).rows[0];

console.log('latest financeiro snap', snapId);

const stats = await query(
  `select
    count(*)::int total,
    count(*) filter (where data->>'RGM' ~ '^[0-9]{8}$')::int rgm8,
    count(*) filter (where data->>'RGM' ~ '^[0-9]+\\.[0-9]+$')::int rgm_decimal,
    count(*) filter (where data->>'RGM' like '49%')::int p49,
    count(*) filter (where data->>'RGM' like '13%')::int p13,
    count(*) filter (where length(coalesce(data->>'RGM','')) between 1 and 7)::int rgm_short
   from financeiro_rows where snapshot_id = $1`,
  [snapId.id]
);
console.log('stats', stats.rows[0]);

const bad = await query(
  `select distinct data->>'RGM' rgm, count(*)::int c
   from financeiro_rows where snapshot_id = $1
   and (data->>'RGM' !~ '^[0-9]{8}$' or data->>'RGM' is null)
   and coalesce(data->>'RGM','') <> ''
   group by 1 order by c desc limit 15`,
  [snapId.id]
);
console.log('RGM fora do padrao:', bad.rows);

const sample = await query(
  `select data->>'RGM' rgm, data->>'Aluno' aluno, data->>'Email' email
   from financeiro_rows where snapshot_id = $1 and data->>'RGM' ~ '^[0-9]{8}$'
   order by data->>'Aluno' limit 5`,
  [snapId.id]
);
console.log('amostra ok:', sample.rows);

const finPath = path.join(
  process.env.USERPROFILE || '',
  'Downloads',
  'Alunos com mensalidade em aberto.xlsx'
);
if (fs.existsSync(finPath)) {
  const buf = fs.readFileSync(finPath);
  for (const cellDates of [true, false]) {
    const wb = XLSX.read(buf, { type: 'buffer', cellDates, dense: true });
    const sheet = wb.Sheets[wb.SheetNames[0]];
    const matrix = Array.isArray(sheet) ? sheet : [];
    const headers = matrix[0]?.map((c) => String(c?.w ?? c?.v ?? '').trim()) ?? [];
    const rgmIdx = headers.findIndex((h) => /^rgm$/i.test(h));
    console.log(`\nXLSX cellDates=${cellDates} header RGM idx`, rgmIdx);
    for (let i = 1; i < Math.min(6, matrix.length); i++) {
      const cell = matrix[i][rgmIdx];
      console.log(' row', i, 'Aluno', matrix[i][headers.indexOf('Aluno')]?.v ?? matrix[i][headers.indexOf('Aluno')], 'RGM', {
        t: cell?.t,
        v: cell?.v,
        w: cell?.w,
      });
    }
  }
}

process.exit(0);
