import * as XLSX from 'xlsx';
import fs from 'fs';

const buf = fs.readFileSync(
  `${process.env.USERPROFILE}/Downloads/Alunos com mensalidade em aberto.xlsx`
);
const wb = XLSX.read(buf, { type: 'buffer', cellDates: false, dense: true });
const m = wb.Sheets['Export'];

for (let r = 1; r <= 3; r++) {
  console.log('\nrow', r);
  for (let c = 0; c < 15; c++) {
    const cell = m[r]?.[c];
    if (!cell) continue;
    const v = cell.v;
    const w = cell.w;
    if (v !== undefined && v !== '' || w) {
      console.log(`  [${c}] t=${cell.t} v=${v} w=${w}`);
    }
  }
}

// sparse read
const wb2 = XLSX.read(buf, { type: 'buffer', cellDates: false, dense: false });
const s = wb2.Sheets['Export'];
const json = XLSX.utils.sheet_to_json(s, { header: 1, defval: '', raw: false });
console.log('\nsparse row1', json[1]);
console.log('sparse row2', json[2]);

process.exit(0);
