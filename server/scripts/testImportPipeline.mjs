import fs from 'fs';
import { xlsxBufferToRowObjects } from '../utils/spreadsheetToObjects.js';

const docsPath = String.raw`C:\Users\Raphael Castro\Downloads\Relação de alunos com documentos pendentes por polo.xlsx`;
const buf = fs.readFileSync(docsPath);
const rows = xlsxBufferToRowObjects(buf, 'docs.xlsx');
const aline = rows.filter((r) => /aline.*bitencourt/i.test(String(r['Nome Aluno'] || '')));
console.log('Aline Rgm import:', aline.map((r) => r.Rgm));
const n49 = rows.filter((r) => /^49\d{6}$/.test(String(r.Rgm || ''))).length;
const n13 = rows.filter((r) => /^13\d{6}$/.test(String(r.Rgm || ''))).length;
console.log('Rgm 49xxxxxx:', n49, 'Rgm 13xxxxxx:', n13);

process.exit(0);
