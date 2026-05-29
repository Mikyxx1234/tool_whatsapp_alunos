import * as XLSX from 'xlsx';
import fs from 'fs';
import path from 'path';

const docsPath = String.raw`C:\Users\Raphael Castro\Downloads\Relação de alunos com documentos pendentes por polo.xlsx`;
const matPath = String.raw`C:\Users\Raphael Castro\Downloads\Relação de matriculados por polo.xlsx`;

function inspect(filePath, label) {
  if (!fs.existsSync(filePath)) {
    console.log(label, 'arquivo não encontrado:', filePath);
    return;
  }
  const buf = fs.readFileSync(filePath);
  const wb = XLSX.read(buf, { type: 'buffer', cellDates: true, cellText: true, dense: true });
  const sheet = wb.Sheets[wb.SheetNames[0]];
  const matrix = Array.isArray(sheet)
    ? sheet
    : (() => {
        const ref = sheet['!ref'];
        if (!ref) return [];
        const range = XLSX.utils.decode_range(ref);
        const m = [];
        for (let r = range.s.r; r <= range.e.r; r++) {
          const row = [];
          for (let c = range.s.c; c <= range.e.c; c++) {
            row.push(sheet[XLSX.utils.encode_cell({ r, c })] ?? '');
          }
          m.push(row);
        }
        return m;
      })();

  const headers = matrix[0]?.map((c) => {
    if (c && typeof c === 'object' && 'w' in c) return String(c.w).trim();
    return String(c?.v ?? c ?? '').trim();
  }) ?? [];
  const rgmIdx = headers.findIndex((h) => /^rgm$/i.test(h));
  const nomeIdx = headers.findIndex((h) => /nome/i.test(h));
  console.log(`\n=== ${label} ===`);
  console.log('headers sample:', headers.slice(0, 15));
  console.log('rgm col index:', rgmIdx);

  for (let i = 1; i < matrix.length; i++) {
    const row = matrix[i];
    const nomeCell = nomeIdx >= 0 ? row[nomeIdx] : null;
    const nome =
      nomeCell && typeof nomeCell === 'object'
        ? String(nomeCell.w ?? nomeCell.v ?? '')
        : String(nomeCell ?? '');
    if (!/aline.*bitencourt/i.test(nome)) continue;
    const rgmCell = rgmIdx >= 0 ? row[rgmIdx] : null;
    console.log('Aline row', i, {
      nome,
      rgmCell,
      v: rgmCell?.v,
      w: rgmCell?.w,
      t: rgmCell?.t,
      z: rgmCell?.z,
    });
    // all cells with 49
    row.forEach((cell, ci) => {
      const w = cell?.w != null ? String(cell.w) : '';
      const v = cell?.v != null ? String(cell.v) : '';
      if (/49004816/.test(w) || /49004816/.test(v)) {
        console.log('  col', headers[ci], 'v=', v, 'w=', w);
      }
    });
  }
}

inspect(docsPath, 'docs Downloads');
inspect(matPath, 'mat Downloads');

process.exit(0);
