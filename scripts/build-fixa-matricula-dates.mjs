/**
 * Fixa de datas: 1ª aparição do RGM = Data de Matrícula;
 * última aparição (data diferente) = Data Rematrícula.
 *
 * Histórico: Matriculados 2022.1 … 2026.1 (Downloads).
 * 2026.2 = snapshot matriculados do dia (Relação).
 *
 *   node --env-file=.env scripts/build-fixa-matricula-dates.mjs
 */
import 'dotenv/config';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { xlsxBufferToRowObjects } from '../server/utils/spreadsheetToObjects.js';
import { extractMatriculadosMappedValues } from '../server/utils/novoCrmFieldMapping.js';
import { normalizeRgm } from '../server/utils/novoCrmCacheNormalize.js';
import {
  classifyTipoMatricula,
  tipoMatriculaFromRow,
} from '../server/utils/matriculadosTipoMatricula.js';
import * as baseUploadRepo from '../server/repositories/baseUploadRepository.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DL = 'C:\\Users\\Raphael Castro\\Downloads';
const HIST = [
  ['2022.1', path.join(DL, 'Matriculados 2022.1.xlsx')],
  ['2022.2', path.join(DL, 'Matriculados 2022.2.xlsx')],
  ['2023.1', path.join(DL, 'Matriculados 2023.1.xlsx')],
  ['2023.2', path.join(DL, 'Matriculados 2023.2.xlsx')],
  ['2024.1', path.join(DL, 'Matriculados 2024.1.xlsx')],
  ['2024.2', path.join(DL, 'Matriculados 2024.2.xlsx')],
  ['2025.1', path.join(DL, 'Matriculados 2025.1.xlsx')],
  ['2025.2', path.join(DL, 'Matriculados 2025.2.xlsx')],
  ['2026.1', path.join(DL, 'Matriculados 2026.1.xlsx')],
];
const SAMPLES = ['41301854', '44792425', '48654973'];

/** @type {Map<string, { nome: string, first_ciclo: string, first_date: string, last_ciclo: string, last_date: string, n_ciclos: number, last_tipo: string, last_tipo_raw: string }>} */
const byRgm = new Map();
const sources = [];

function ingest(ciclo, rows, fileName) {
  const seen = new Map();
  for (const row of rows) {
    const m = extractMatriculadosMappedValues(row);
    const rgm = normalizeRgm(m.rgm);
    if (!rgm) continue;
    const date = m.data_matricula || '';
    const tipoRaw = tipoMatriculaFromRow(row);
    const prev = seen.get(rgm);
    if (!prev) {
      seen.set(rgm, {
        nome: m._nome_full || '',
        minDate: date,
        maxDate: date,
        tipoRaw,
        tipo: classifyTipoMatricula(tipoRaw),
      });
      continue;
    }
    if (date && (!prev.minDate || date < prev.minDate)) prev.minDate = date;
    if (date && (!prev.maxDate || date > prev.maxDate)) prev.maxDate = date;
    if (m._nome_full) prev.nome = m._nome_full;
    if (tipoRaw) {
      prev.tipoRaw = tipoRaw;
      prev.tipo = classifyTipoMatricula(tipoRaw);
    }
  }
  for (const [rgm, rec] of seen) {
    const cur = byRgm.get(rgm);
    if (!cur) {
      byRgm.set(rgm, {
        nome: rec.nome,
        first_ciclo: ciclo,
        first_date: rec.minDate,
        last_ciclo: ciclo,
        last_date: rec.maxDate,
        n_ciclos: 1,
        last_tipo: rec.tipo,
        last_tipo_raw: rec.tipoRaw,
      });
      continue;
    }
    cur.last_ciclo = ciclo;
    if (rec.maxDate) cur.last_date = rec.maxDate;
    cur.n_ciclos += 1;
    cur.last_tipo = rec.tipo;
    cur.last_tipo_raw = rec.tipoRaw;
    if (rec.nome) cur.nome = rec.nome;
  }
  sources.push({
    ciclo,
    file: fileName,
    rows: rows.length,
    unique_rgm: seen.size,
  });
}

for (const [ciclo, file] of HIST) {
  if (!fs.existsSync(file)) {
    console.error(`arquivo ausente: ${file}`);
    process.exit(1);
  }
  const rows = xlsxBufferToRowObjects(fs.readFileSync(file), path.basename(file));
  ingest(ciclo, rows, path.basename(file));
}

const snap = await baseUploadRepo.getLatestSnapshot('matriculados');
if (!snap?.id) {
  console.error('Snapshot matriculados (2026.2) ausente');
  process.exit(1);
}
const liveRows = [];
await baseUploadRepo.forEachRowDataForSnapshot('matriculados', snap.id, (row) => {
  liveRows.push(row);
});
ingest('2026.2', liveRows, snap.file_name || 'snapshot');

let onlyOnce = 0;
let remat = 0;
let sameDate = 0;
let noFirst = 0;
let inLive = 0;
for (const rec of byRgm.values()) {
  if (!rec.first_date) noFirst += 1;
  if (rec.last_ciclo === '2026.2') inLive += 1;
  if (rec.n_ciclos === 1) onlyOnce += 1;
  else if (rec.last_date && rec.first_date && rec.last_date !== rec.first_date) remat += 1;
  else sameDate += 1;
}

const samples = {};
for (const rgm of SAMPLES) {
  samples[rgm] = byRgm.get(rgm) || null;
}

const out = {
  generated_at: new Date().toISOString(),
  live_snapshot: { id: snap.id, file_name: snap.file_name, created_at: snap.created_at },
  sources,
  stats: {
    rgms: byRgm.size,
    only_once: onlyOnce,
    rematriculou: remat,
    multi_ciclo_mesma_data: sameDate,
    sem_primeira_data: noFirst,
    ainda_na_relacao_2026_2: inLive,
  },
  samples,
  people: Object.fromEntries(
    [...byRgm.entries()].map(([rgm, rec]) => [
      rgm,
      {
        n: rec.nome,
        f: rec.first_date,
        fc: rec.first_ciclo,
        l: rec.last_date,
        lc: rec.last_ciclo,
        k: rec.n_ciclos,
        t: rec.last_tipo,
      },
    ]),
  ),
};

const outPath = path.join(ROOT, 'data', 'fixa-matricula-dates.json');
fs.writeFileSync(outPath, JSON.stringify(out));
const report = { out: outPath, sources, stats: out.stats, samples };
fs.writeFileSync(path.join(ROOT, 'data', '_fixa-matricula-report.json'), JSON.stringify(report, null, 2));
console.log(JSON.stringify(report, null, 2));
process.exit(0);
