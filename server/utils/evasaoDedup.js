import { cicloFromRow } from './cicloFromRow.js';
import { normalizeRgmCanonical } from './rgmDisplay.js';

const EVASAO_SCORE_KEYS = [
  'Evasão Média',
  'Evasao Media',
  'Evasão media',
  'evasao_media',
  'Evasao Média',
  'Probabilidade Evasão',
  'Probabilidade Evasao',
];

function digits(v) {
  return String(v ?? '')
    .replace(/\D/g, '')
    .trim();
}

/**
 * @param {Record<string, unknown>} row
 * @returns {number}
 */
export function evasaoScoreFromRow(row) {
  for (const k of EVASAO_SCORE_KEYS) {
    const raw = row[k];
    if (raw === null || raw === undefined || raw === '') continue;
    const n = parseFloat(String(raw).trim().replace(',', '.'));
    if (Number.isFinite(n)) return n;
  }
  return -1;
}

/**
 * @param {Record<string, unknown>} row
 * @returns {string | null}
 */
export function evasaoDedupKey(row) {
  const rgm = normalizeRgmCanonical(row.RGM ?? row.Rgm ?? row.Matricula);
  if (!rgm) return null;
  const ciclo = cicloFromRow(row);
  return ciclo ? `RGM:${rgm}\t${ciclo}` : `RGM:${rgm}`;
}

/**
 * @param {Record<string, unknown>[]} objects
 * @returns {{ rows: Record<string, unknown>[], removed: number, skipped_no_key: number }}
 */
export function dedupeProvavelEvasaoRows(objects) {
  /** @type {Map<string, { row: Record<string, unknown>, score: number }>} */
  const best = new Map();
  let skipped = 0;

  for (const row of objects) {
    const key = evasaoDedupKey(row);
    if (!key) {
      skipped += 1;
      continue;
    }
    const score = evasaoScoreFromRow(row);
    const cur = best.get(key);
    if (!cur || score > cur.score) {
      best.set(key, { row, score });
    }
  }

  const rows = [...best.values()].map((x) => x.row);
  return {
    rows,
    removed: Math.max(0, objects.length - rows.length - skipped),
    skipped_no_key: skipped,
  };
}

/**
 * @param {Record<string, unknown>} incoming
 * @param {Record<string, unknown>|undefined} current
 */
export function shouldReplaceEvasaoRow(incoming, current) {
  if (!current) return true;
  return evasaoScoreFromRow(incoming) > evasaoScoreFromRow(current);
}
