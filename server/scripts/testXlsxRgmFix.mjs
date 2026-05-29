import * as XLSX from 'xlsx';
import fs from 'fs';

const files = [
  ['docs', String.raw`C:\Users\Raphael Castro\Downloads\Relação de alunos com documentos pendentes por polo.xlsx`],
  ['mat', String.raw`C:\Users\Raphael Castro\Downloads\Relação de matriculados por polo.xlsx`],
];

for (const [label, filePath] of files) {
  const buf = fs.readFileSync(filePath);
  const wb = XLSX.read(buf, { type: 'buffer', cellDates: false, cellText: true, dense: true });
  const sheet = wb.Sheets[wb.SheetNames[0]];
  const matrix = Array.isArray(sheet) ? sheet : [];
  const headers = matrix[0]?.map((c) => String(c?.w ?? c?.v ?? '').trim()) ?? [];
  const rgmIdx = headers.findIndex((h) => /^rgm$/i.test(h));
  const nomeIdx = headers.findIndex((h) => /nome/i.test(h));
  for (let i = 1; i < matrix.length; i++) {
    const nome = String(matrix[i][nomeIdx]?.w ?? matrix[i][nomeIdx]?.v ?? '');
    if (!/aline.*bitencourt/i.test(nome)) continue;
    const cell = matrix[i][rgmIdx];
    console.log(label, 'Aline RGM v=', cell?.v, 't=', cell?.t);
  }
}

process.exit(0);
