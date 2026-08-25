/**
 * Fixa de datas de matrícula/rematrícula (histórico SIAA 2022.1→2026.2).
 * 1ª aparição do RGM = Data de Matrícula; última data diferente = Data Rematrícula.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { normalizeRgm } from './novoCrmCacheNormalize.js';

const DATA_PATH = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  'data',
  'fixa-matricula-dates.json'
);

/** @type {Map<string, { first: string, last: string, n: number }>|null} */
let cached;

export function resetFixaMatriculaDatesCache() {
  cached = undefined;
}

function load() {
  if (cached) return cached;
  cached = new Map();
  try {
    const file = JSON.parse(fs.readFileSync(DATA_PATH, 'utf8'));
    const people = file.people || {};
    for (const [rgmRaw, rec] of Object.entries(people)) {
      const rgm = normalizeRgm(rgmRaw);
      if (!rgm || !rec) continue;
      const first = String(rec.f || rec.first_date || '').trim();
      const last = String(rec.l || rec.last_date || '').trim();
      const n = Number(rec.k || rec.n_ciclos) || 0;
      if (!first && !last) continue;
      cached.set(rgm, { first, last, n });
    }
  } catch {
    cached = new Map();
  }
  return cached;
}

/**
 * @param {string} rgm
 * @returns {{ data_matricula: string, data_rematricula: string }|null}
 */
export function fixaDatesForRgm(rgm) {
  const rec = load().get(normalizeRgm(rgm));
  if (!rec) return null;
  const rematriculou = Boolean(rec.n > 1 && rec.last && rec.first && rec.last !== rec.first);
  return {
    data_matricula: rec.first || '',
    data_rematricula: rematriculou ? rec.last : '',
  };
}

/**
 * Pares {fieldId,value} da Fixa. Sem RGM / sem arquivo → [].
 * @param {{ data_matricula?: string, data_rematricula?: string }} fieldIds
 * @param {string} rgm
 */
export function fixaDateFieldPairs(fieldIds, rgm) {
  const dates = fixaDatesForRgm(rgm);
  if (!dates) return [];
  /** @type {Array<{fieldId:string,value:string}>} */
  const out = [];
  const matId = String(fieldIds?.data_matricula || '').trim();
  const rematId = String(fieldIds?.data_rematricula || '').trim();
  if (matId && dates.data_matricula) {
    out.push({ fieldId: matId, value: dates.data_matricula });
  }
  if (rematId && dates.data_rematricula) {
    out.push({ fieldId: rematId, value: dates.data_rematricula });
  }
  return out;
}
