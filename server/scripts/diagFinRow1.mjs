import * as XLSX from 'xlsx';
import fs from 'fs';

const buf = fs.readFileSync(
  String.raw`C:\Users\Raphael Castro\Downloads\Alunos com mensalidade em aberto.xlsx`
);
const wb = XLSX.read(buf, { type: 'buffer', cellDates: false, dense: true });
const m = wb.Sheets[wb.SheetNames[0]];
const h = m[0].map((c) => String(c?.w ?? c?.v ?? '').trim());
const r = m[1];
h.forEach((name, i) => console.log(i, name, '=', r[i]?.v ?? r[i]?.w));

process.exit(0);
