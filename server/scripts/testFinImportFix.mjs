import fs from 'fs';
import { xlsxBufferToRowObjects } from '../utils/spreadsheetToObjects.js';

const buf = fs.readFileSync(
  `${process.env.USERPROFILE}/Downloads/Alunos com mensalidade em aberto.xlsx`
);
const rows = xlsxBufferToRowObjects(buf, 'fin.xlsx');
const m = rows.find((r) => /MARGARETE/i.test(r.Aluno || ''));
console.log('Margarete', { RGM: m?.RGM, Valor: m?.Valor, Aluno: m?.Aluno });
const n49 = rows.filter((r) => /^49\d{6}$/.test(String(r.RGM || ''))).length;
const n8 = rows.filter((r) => /^\d{8}$/.test(String(r.RGM || ''))).length;
console.log('RGM 8dig', n8, 'prefix 49', n49);
process.exit(0);
