import * as XLSX from 'xlsx';
import fs from 'fs';

const paths = [
  'C:/Users/Raphael Castro/Downloads/Alunos com mensalidade em aberto.xlsx',
  'C:/Users/Raphael Castro/Documents/Alunos com mensalidade em aberto.xlsx',
];

for (const p of paths) {
  if (!fs.existsSync(p)) continue;
  const wb = XLSX.readFile(p, { cellText: true, cellDates: true });
  const sh = wb.Sheets[wb.SheetNames[0]];
  const rows = XLSX.utils.sheet_to_json(sh, { header: 1, defval: '', raw: false });
  console.log('FILE:', p);
  console.log('header:', rows[0]);
  for (let i = 1; i <= 6; i++) {
    const row = rows[i];
    const rgmIdx = rows[0].findIndex((h) => String(h).toUpperCase().includes('RGM'));
    console.log(`row${i} RGM col:`, row[rgmIdx], 'aluno:', row[rows[0].indexOf('Aluno')] ?? row[1]);
  }
  // also read raw cell
  const a2 = sh['A2'] || sh[XLSX.utils.encode_cell({ r: 1, c: rgmIdx })];
  console.log('cell sample', sh[XLSX.utils.encode_cell({ r: 1, c: 0 })], sh[XLSX.utils.encode_cell({ r: 1, c: 0 })]);
  break;
}
