/**
 * Gera data/marco-pre-rgms.json a partir da Relação 2025/2.
 *
 *   node scripts/build-marco-pre-rgms.mjs "C:\Users\Raphael Castro\Downloads\matriculados_25.2 (1).xlsx"
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import XLSX from 'xlsx';
import { toIsoDate } from '../server/utils/dateParser.js';
import { importRgmCellValue } from '../server/utils/rgmDisplay.js';
import { classifyTipoMatricula } from '../server/utils/matriculadosTipoMatricula.js';
import { normalizeCpf, normalizeRgm } from '../server/utils/novoCrmCacheNormalize.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const INGRESSANTE_ATE = '2025-09-13';
const FILE = process.argv[2];
if (!FILE || !fs.existsSync(FILE)) {
  console.error('Uso: node scripts/build-marco-pre-rgms.mjs <xlsx>');
  process.exit(1);
}

function strip(s) {
  return String(s || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .trim();
}

function isIngressanteTipo(raw) {
  const t = classifyTipoMatricula(raw);
  if (t === 'novos') return true;
  const s = strip(raw);
  return s.includes('calouro') || s.includes('ingress') || s.includes('nova matricula') || s === 'nova';
}

const wb = XLSX.read(fs.readFileSync(FILE), { type: 'buffer', cellText: true, cellDates: false });
const matrix = XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { header: 1, defval: '', raw: false });
let map = null;
const tipoHist = new Map();
const rows = [];
for (const raw of matrix) {
  const c0 = String(raw[0] || '').trim();
  if (!c0) continue;
  if (/^relacao de alunos/i.test(strip(c0)) || /^polo:/i.test(strip(c0))) {
    map = null;
    continue;
  }
  if (strip(c0) === 'nome') {
    map = {};
    raw.forEach((h, i) => {
      const k = strip(h);
      if (k === 'cpf') map.cpf = i;
      if (k === 'rgm') map.rgm = i;
      if (k === 'dta.matricula' || k === 'data matricula' || k === 'data de matricula') map.data = i;
      if (k.includes('tipo matricula')) map.tipo = i;
    });
    continue;
  }
  if (!map || map.rgm == null) continue;
  const tipoRaw = String(raw[map.tipo] ?? '').trim();
  const rgm = normalizeRgm(importRgmCellValue(raw[map.rgm]));
  const cpf = normalizeCpf(raw[map.cpf]);
  const data = toIsoDate(raw[map.data]) || '';
  if (!rgm && !cpf) continue;
  tipoHist.set(tipoRaw || '(vazio)', (tipoHist.get(tipoRaw || '(vazio)') || 0) + 1);
  rows.push({ rgm, cpf, tipoRaw, data });
}

const preRgm = new Set();
const preCpf = new Set();
let vet = 0;
let ingOk = 0;
let ingLate = 0;
let ingNoDate = 0;
for (const r of rows) {
  if (isIngressanteTipo(r.tipoRaw)) {
    if (!r.data) {
      ingNoDate += 1;
      continue;
    }
    if (r.data <= INGRESSANTE_ATE) {
      ingOk += 1;
      if (r.rgm) preRgm.add(r.rgm);
      if (r.cpf) preCpf.add(r.cpf);
    } else ingLate += 1;
  } else {
    vet += 1;
    if (r.rgm) preRgm.add(r.rgm);
    if (r.cpf) preCpf.add(r.cpf);
  }
}

const outPath = path.join(ROOT, 'data', 'marco-pre-rgms.json');
const payload = {
  source: path.basename(FILE),
  source_path: FILE,
  ingressante_ate: INGRESSANTE_ATE,
  generated_at: new Date().toISOString(),
  rgms: [...preRgm].sort(),
  cpfs: [...preCpf].sort(),
};
fs.writeFileSync(outPath, JSON.stringify(payload, null, 0));
const report = {
  file: FILE,
  rows: rows.length,
  tipos: Object.fromEntries(tipoHist),
  vet,
  ingOk,
  ingLate,
  ingNoDate,
  pre_rgms: preRgm.size,
  pre_cpfs: preCpf.size,
  out: outPath,
};
fs.writeFileSync(path.join(ROOT, 'data', '_marco-252-certo.json'), JSON.stringify(report, null, 2));
console.log(JSON.stringify(report, null, 2));
