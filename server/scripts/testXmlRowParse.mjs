import * as XLSX from 'xlsx';
import fs from 'fs';

const buf = fs.readFileSync(
  `${process.env.USERPROFILE}/Downloads/Alunos com mensalidade em aberto.xlsx`
);

const cfb = XLSX.CFB.read(buf, { type: 'buffer' });
const entry = XLSX.CFB.find(cfb, (n) => /worksheets\/sheet1\.xml$/i.test(n));
const xml = entry ? Buffer.from(entry.content).toString('utf8') : '';

function cellsFromRowXml(rowXml) {
  const cells = [];
  const cellRe = /<x:c[^>]*>([\s\S]*?)<\/x:c>/g;
  let m;
  while ((m = cellRe.exec(rowXml))) {
    const inner = m[1];
    const t = /<x:t[^>]*>([^<]*)<\/x:t>/.exec(inner);
    const v = /<x:v>([^<]*)<\/x:v>/.exec(inner);
    cells.push(t ? t[1].trim() : v ? v[1].trim() : '');
  }
  return cells;
}

const rows = [...xml.matchAll(/<x:row[^>]*>([\s\S]*?)<\/x:row>/g)].map((m) => m[1]);
console.log('rows', rows.length);
const h = cellsFromRowXml(rows[0]);
console.log('header', h);
for (let i = 1; i <= 3; i++) {
  const cells = cellsFromRowXml(rows[i]);
  console.log('data', i, 'rgm', cells[0], 'valor', cells[cells.length - 1]);
}

process.exit(0);
