import { readFileSync } from 'node:fs';
import { argv } from 'node:process';
import XLSX from 'xlsx';

const file = argv[2];
if (!file) {
  console.error('uso: node scripts/inspect-xlsx.mjs <arquivo.xlsx>');
  process.exit(1);
}

const buffer = readFileSync(file);
const wb = XLSX.read(buffer, { cellDates: true, type: 'buffer' });
console.log('Sheets:', wb.SheetNames);

for (const name of wb.SheetNames) {
  const ws = wb.Sheets[name];
  const json = XLSX.utils.sheet_to_json(ws, { defval: null, raw: false });
  console.log(`\n--- Sheet: ${name} ---`);
  console.log(`linhas: ${json.length}`);
  if (json.length > 0) {
    console.log('colunas:', Object.keys(json[0]));
    console.log('amostra (3 linhas):');
    console.log(JSON.stringify(json.slice(0, 3), null, 2));
    if (json.length > 3) {
      console.log(`...e mais ${json.length - 3} linhas`);
    }
  }
}
