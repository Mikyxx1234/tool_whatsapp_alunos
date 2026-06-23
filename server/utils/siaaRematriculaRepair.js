import {
  institutionalRgmFromAnyRow,
  isValidRematriculaRgm,
  normalizeRgmCanonical,
  displayRgmFromRematriculaRow,
} from './rgmDisplay.js';
import { cpfDigitsFromExcelCell, phoneDigitsFromExcelCell } from './excelNumericCell.js';
import { isPlaceholderContact } from './datacrazySearchTerm.js';

function siaaPhoneFieldDigits(raw) {
  if (isPlaceholderContact(raw)) return '';
  return phoneDigitsFromExcelCell(raw);
}

/**
 * Corrige CPF/telefone em notação científica no export SIAA (antes do sanitize).
 * @param {Record<string, unknown>} row
 */
export function repairRematriculaNumericFields(row) {
  if (!row || typeof row !== 'object') return row;
  /** @type {Record<string, unknown>} */
  const out = { ...row };
  for (const [key, val] of Object.entries(row)) {
    const s = String(val ?? '').trim();
    if (!s) continue;
    if (/cpf/i.test(key)) {
      const cpf = cpfDigitsFromExcelCell(s);
      if (cpf) out[key] = cpf;
      continue;
    }
    if (/ddd/i.test(key)) {
      if (isPlaceholderContact(s)) {
        out[key] = '';
        continue;
      }
      let ddd = phoneDigitsFromExcelCell(s);
      if (ddd.length > 2) ddd = ddd.slice(-2);
      if (ddd.length === 1) ddd = ddd.padStart(2, '0');
      if (ddd) out[key] = ddd;
      continue;
    }
    if (/fone|cel|tel/i.test(key) && !/^ddd/i.test(key)) {
      if (isPlaceholderContact(s)) {
        out[key] = '';
        continue;
      }
      const fone = phoneDigitsFromExcelCell(s);
      if (fone) out[key] = fone;
    }
  }
  return out;
}

/**
 * SIAA Rematrícula: col U (DDD_CEL) + col V (FONE_CEL) → celular completo.
 * @param {Record<string, unknown>} row
 * @returns {string}
 */
export function buildSiaaCelularFromDddAndFone(row) {
  if (!row || typeof row !== 'object') return '';

  let ddd = siaaPhoneFieldDigits(row.DDD_CEL ?? row.DDD ?? '');
  let fone = siaaPhoneFieldDigits(row.FONE_CEL ?? row.FONE ?? row.Celular ?? '');

  if (ddd.length > 2) ddd = ddd.slice(-2);
  if (ddd.length === 1) ddd = ddd.padStart(2, '0');

  if (!ddd && !fone) return '';
  if (!ddd) return fone.length >= 10 && fone.length <= 11 ? fone : '';
  if (!fone) return '';

  if (fone.length === 8) fone = `9${fone}`;
  if (fone.length >= 10 && fone.startsWith(ddd)) {
    return fone.length > 11 ? fone.slice(-11) : fone;
  }

  const merged = `${ddd}${fone}`.replace(/\D/g, '');
  if (merged.length >= 10 && merged.length <= 11) return merged;
  if (merged.length > 11) return merged.slice(-11);
  return merged;
}

/**
 * Normaliza contatos do export SIAA: CPF (col J), e-mail (col W), telefone (U+V).
 * @param {Record<string, unknown>} row
 */
export function normalizeSiaaRematriculaContactFields(row) {
  if (!row || typeof row !== 'object') return row;
  const out = repairRematriculaNumericFields(row);

  const cpf = cpfDigitsFromSiaaRow(out);
  if (cpf) {
    out.CPF_ALUN = cpf;
    out.CPF = cpf;
  }

  const email = String(out.E_MAIL ?? out.Email ?? out['E-mail'] ?? '').trim().toLowerCase();
  if (email) out.E_MAIL = email;

  const celular = buildSiaaCelularFromDddAndFone(out);
  if (celular && celular.length >= 10 && celular.length <= 11) {
    out.FONE_CEL = celular;
    out.TELEFONE_CEL = celular;
  } else {
    out.FONE_CEL = '';
    out.TELEFONE_CEL = '';
  }

  return out;
}

/**
 * Corrige RGM + contatos em linhas do export SIAA Rematrícula.
 * @param {Record<string, unknown>} row
 */
export function repairSiaaRematriculaRow(row) {
  if (!row || typeof row !== 'object') return row;
  const out = normalizeSiaaRematriculaContactFields(row);
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
  const celular = buildSiaaCelularFromDddAndFone(row);
  if (celular.length >= 10 && celular.length <= 11) score += 3;
  if (String(row.E_MAIL ?? '').includes('@')) score += 2;
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
