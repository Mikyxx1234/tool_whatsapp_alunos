import * as XLSX from 'xlsx';
import fs from 'fs';

const buf = fs.readFileSync(
  `${process.env.USERPROFILE}/Downloads/Alunos com mensalidade em aberto.xlsx`
);

const wb = XLSX.read(buf, { type: 'buffer', cellDates: false, dense: false });
const sheet = wb.Sheets['Export'];
console.log('before ref', sheet['!ref']);

// fix broken ref
const range = XLSX.utils.decode_range(sheet['!ref']);
if (range.s.c < 0) {
  sheet['!ref'] = XLSX.utils.encode_range({
    s: { r: 0, c: 0 },
    e: { r: range.e.r, c: range.e.c },
  });
}
console.log('after ref', sheet['!ref']);

const json = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: '', raw: false });
console.log('header', json[0]);
console.log('row1', json[1]);
console.log('row2', json[2]);

process.exit(0);
