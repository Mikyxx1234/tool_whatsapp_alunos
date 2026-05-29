import * as XLSX from 'xlsx';
import fs from 'fs';

const finPath = String.raw`C:\Users\Raphael Castro\Downloads\Alunos com mensalidade em aberto.xlsx`;
const buf = fs.readFileSync(finPath);
const wb = XLSX.read(buf, { type: 'buffer', cellDates: false, dense: true });
const sheet = wb.Sheets[wb.SheetNames[0]];
const matrix = Array.isArray(sheet) ? sheet : [];

console.log('sheet', wb.SheetNames[0], 'rows', matrix.length);
for (let r = 0; r < Math.min(5, matrix.length); r++) {
  const row = matrix[r];
  const vals = row?.map((c, i) => {
    const h = c?.w ?? c?.v ?? '';
    return `[${i}]${String(h).slice(0, 20)}`;
  });
  console.log('row', r, vals?.slice(0, 12).join(' | '));
}

// find header row with RGM
for (let r = 0; r < Math.min(20, matrix.length); r++) {
  const row = matrix[r];
  const texts = row?.map((c) => String(c?.w ?? c?.v ?? '').trim()) ?? [];
  if (texts.some((t) => /^rgm$/i.test(t))) {
    console.log('\nheader row', r, texts);
    const rgmIdx = texts.findIndex((t) => /^rgm$/i.test(t));
    for (let i = r + 1; i < r + 4; i++) {
      const data = matrix[i];
      console.log(
        ' data',
        i,
        'RGM cell',
        data?.[rgmIdx],
        'Aluno',
        data?.[texts.findIndex((t) => /aluno/i.test(t))]
      );
    }
    break;
  }
}

process.exit(0);
