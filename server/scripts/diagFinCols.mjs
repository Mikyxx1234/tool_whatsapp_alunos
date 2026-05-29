import * as XLSX from 'xlsx';
import fs from 'fs';

const buf = fs.readFileSync(
  String.raw`C:\Users\Raphael Castro\Downloads\Alunos com mensalidade em aberto.xlsx`
);
const wb = XLSX.read(buf, { type: 'buffer', cellDates: false, dense: true });
const matrix = wb.Sheets[wb.SheetNames[0]];

const headers = matrix[0].map((c) => String(c?.w ?? c?.v ?? '').trim());
console.log('headers', headers);

// scan each column for 8-digit pattern count
for (let c = 0; c < headers.length; c++) {
  let n8 = 0;
  let n49 = 0;
  let nDec = 0;
  for (let r = 1; r < matrix.length; r++) {
    const v = matrix[r][c]?.v;
    const s = String(v ?? '').trim();
    if (/^\d{8}$/.test(s) || (typeof v === 'number' && v >= 10_000_000 && v < 100_000_000 && Number.isInteger(v))) n8++;
    if (/^49\d{6}$/.test(s) || (typeof v === 'number' && v >= 49000000 && v < 50000000)) n49++;
    if (/^\d+\.\d{1,2}$/.test(s) || (typeof v === 'number' && v < 10000 && !Number.isInteger(v))) nDec++;
  }
  if (n8 || n49 || nDec)
    console.log(`col ${c} [${headers[c]}]: 8dig=${n8} 49xxx=${n49} decimal=${nDec}`);
}

// check user's earlier financeiro image - Nome Aluno, Rgm 49005154 - different file?
const alt = String.raw`C:\Users\Raphael Castro\Documents\Nova pasta`;
import { readdirSync, existsSync } from 'fs';
import path from 'path';
if (existsSync(alt)) {
  for (const f of readdirSync(alt)) {
    if (/mensalidade|financeiro|aberto/i.test(f) && f.endsWith('.xlsx')) {
      console.log('\nalt file', f);
    }
  }
}

process.exit(0);
