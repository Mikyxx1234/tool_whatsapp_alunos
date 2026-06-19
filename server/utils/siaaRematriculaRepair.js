import {
  institutionalRgmFromAnyRow,
  isValidRematriculaRgm,
  normalizeRgmCanonical,
  displayRgmFromRematriculaRow,
} from './rgmDisplay.js';
import { cpfDigitsFromExcelCell } from './excelNumericCell.js';

/**
 * Corrige RGM em linhas do export SIAA Rematrícula.
 * @param {Record<string, unknown>} row
 */
export function repairSiaaRematriculaRow(row) {
  if (!row || typeof row !== 'object') return row;
  const out = { ...row };
  const found = displayRgmFromRematriculaRow(row) || institutionalRgmFromAnyRow(row);
  if (found) {
    out.RGM_ALUN = found;
    out.RGM = found;
  } else {
    out.RGM_ALUN = '';
    out.RGM = '';
  }
  return out;
}

/**
 * @param {Record<string, unknown>} row
 */
export function cpfDigitsFromSiaaRow(row) {
  const raw = row.CPF_ALUN ?? row.CPF ?? row['CPF Aluno'] ?? '';
  const d = cpfDigitsFromExcelCell(raw);
  if (d.length === 11) return d;
  return '';
}

/**
 * Prioridade para dedupe no ZIP SIAA: linha com RGM institucional válido vence.
 * @param {Record<string, unknown>} row
 */
export function siaaRematriculaRowQuality(row) {
  let score = 0;
  const rgm = institutionalRgmFromAnyRow(row);
  if (rgm) score += 1000 + parseInt(rgm.slice(0, 2), 10);
  if (String(row.NOME ?? row.Nome ?? '').trim()) score += 10;
  if (cpfDigitsFromSiaaRow(row)) score += 5;
  if (String(row.SIT_FINAN ?? '').trim()) score += 2;
  if (String(row.SIT_ATUAL ?? '').trim()) score += 2;
  return score;
}

/**
 * @param {Record<string, unknown>} row
 * @param {string} [raw]
 */
export function siaaRgmFromRaw(raw) {
  const canon = normalizeRgmCanonical(raw);
  return canon && isValidRematriculaRgm(canon) ? canon : '';
}
