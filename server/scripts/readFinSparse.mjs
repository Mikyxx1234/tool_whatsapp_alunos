import * as XLSX from 'xlsx';
import fs from 'fs';

const buf = fs.readFileSync(
  `${process.env.USERPROFILE}/Downloads/Alunos com mensalidade em aberto.xlsx`
);

const wb = XLSX.read(buf, { type: 'buffer', cellDates: false, dense: false });
const sheet = wb.Sheets['Export'];
console.log('!ref', sheet['!ref']);

const cells = ['A1', 'K1', 'A2', 'K2', 'A3', 'K3', 'B2', 'E2'];
for (const addr of cells) {
  const c = sheet[addr];
  console.log(addr, c ? { t: c.t, v: c.v, w: c.w } : null);
}

// manual range decode
if (sheet['!ref']) {
  const range = XLSX.utils.decode_range(sheet['!ref']);
  console.log('range', range);
}

process.exit(0);
