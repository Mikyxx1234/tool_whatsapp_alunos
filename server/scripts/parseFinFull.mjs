import * as XLSX from 'xlsx';
import fs from 'fs';
import path from 'path';

const paths = [
  path.join(process.env.USERPROFILE || '', 'Downloads', 'Alunos com mensalidade em aberto.xlsx'),
  path.join(process.env.USERPROFILE || '', 'Documents', 'Nova pasta', 'Alunos com mensalidade em aberto.xlsx'),
].filter((p) => fs.existsSync(p));

for (const filePath of paths) {
  console.log('\n====', filePath, '====');
  const buf = fs.readFileSync(filePath);
  const wb = XLSX.read(buf, { type: 'buffer', cellDates: false, cellText: true, dense: true });
  console.log('sheets', wb.SheetNames);
  const sheet = wb.Sheets[wb.SheetNames[0]];
  const matrix = Array.isArray(sheet) ? sheet : [];
  console.log('rows', matrix.length);

  for (let r = 0; r < Math.min(4, matrix.length); r++) {
    const row = matrix[r];
    const cells = row?.map((c, i) => {
      const v = c?.v;
      const w = c?.w;
      return `[${i}]${String(w ?? v ?? '').slice(0, 12)}`;
    });
    console.log('r', r, cells?.join(' | '));
  }

  const headers = matrix[0]?.map((c) => String(c?.w ?? c?.v ?? '').trim()) ?? [];
  const rgmIdx = headers.findIndex((h) => /^rgm$/i.test(h));
  const valIdx = headers.findIndex((h) => /^valor$/i.test(h));
  console.log('rgmIdx', rgmIdx, 'valorIdx', valIdx);

  for (let i = 1; i < Math.min(6, matrix.length); i++) {
    const rgm = matrix[i][rgmIdx];
    const val = matrix[i][valIdx];
    const aluno = matrix[i][headers.indexOf('Aluno')];
    console.log('data', i, {
      aluno: aluno?.v ?? aluno?.w,
      rgm_v: rgm?.v,
      rgm_w: rgm?.w,
      rgm_t: rgm?.t,
      valor_v: val?.v,
      valor_w: val?.w,
    });
  }
}

process.exit(0);
