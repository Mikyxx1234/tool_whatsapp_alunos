import {
  isPlausibleInstitutionalRgm,
  isRgmColumnKey,
  normalizeRgmCanonical,
  rgmRawFromRow,
} from './rgmDisplay.js';

const RGM_KEY_HINT = /rgm|matricula/i;

/**
 * Corrige RGM em linhas do export SIAA Rematrícula: descarta lixo (prefixo >49, CPF
 * truncado, coluna deslocada) e tenta achar o RGM institucional em outra coluna da linha.
 *
 * @param {Record<string, unknown>} row
 */
export function repairSiaaRematriculaRow(row) {
  if (!row || typeof row !== 'object') return row;
  const out = { ...row };

  const rawPrimary = rgmRawFromRow(row);
  const canonPrimary = normalizeRgmCanonical(rawPrimary);
  if (canonPrimary && isPlausibleInstitutionalRgm(canonPrimary)) {
    out.RGM_ALUN = canonPrimary;
    out.RGM = canonPrimary;
    return out;
  }

  /** @type {Array<{ canon: string, score: number }>} */
  const candidates = [];
  for (const [key, val] of Object.entries(row)) {
    const s = String(val ?? '').trim();
    if (!s || s.includes('@')) continue;
    const digitLen = s.replace(/\D/g, '').length;
    if (digitLen === 11) continue;
    const canon = normalizeRgmCanonical(s);
    if (!canon || !isPlausibleInstitutionalRgm(canon)) continue;
    let score = 0;
    if (isRgmColumnKey(key) || RGM_KEY_HINT.test(key)) score += 10;
    if (key === 'RGM_ALUN' || key === 'RGM') score += 5;
    candidates.push({ canon, score });
  }

  if (candidates.length) {
    candidates.sort((a, b) => b.score - a.score);
    out.RGM_ALUN = candidates[0].canon;
    out.RGM = candidates[0].canon;
    return out;
  }

  out.RGM_ALUN = '';
  out.RGM = '';
  return out;
}

/**
 * @param {Record<string, unknown>} row
 */
export function cpfDigitsFromSiaaRow(row) {
  const d = String(row.CPF_ALUN ?? row.CPF ?? row['CPF Aluno'] ?? '')
    .replace(/\D/g, '');
  if (d.length >= 11) return d.slice(-11);
  return '';
}
