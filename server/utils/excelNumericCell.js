/**
 * Converte valores numéricos de células Excel (incl. notação científica) para string estável.
 * Ex.: "4.8982197E7" → "48982197", "3.240816687E10" → "32408166870"
 * @param {unknown} raw
 * @param {{ pad?: number, maxDigits?: number }} [opts]
 * @returns {string}
 */
export function parseExcelNumericCell(raw, opts = {}) {
  let s = String(raw ?? '').trim();
  if (!s) return '';

  // Excel pt-BR: "9,43E+08" / "4,58E+10"
  if (/[eE]/.test(s) && s.includes(',')) {
    s = s.replace(',', '.');
  }

  if (/^\d+$/.test(s)) {
    if (opts.pad && s.length < opts.pad) return s.padStart(opts.pad, '0');
    return s;
  }

  if (/^[+-]?\d*\.?\d+[eE][+-]?\d+$/.test(s)) {
    const n = Number(s);
    if (!Number.isFinite(n)) return s;
    if (Math.abs(n - Math.round(n)) > 1e-6) return s;
    let out = String(Math.round(Math.abs(n)));
    if (opts.maxDigits && out.length > opts.maxDigits) {
      out = out.slice(-opts.maxDigits);
    }
    if (opts.pad && out.length < opts.pad) {
      out = out.padStart(opts.pad, '0');
    }
    return out;
  }

  return s;
}

/**
 * @param {unknown} raw
 * @returns {string} 11 dígitos ou vazio
 */
export function cpfDigitsFromExcelCell(raw) {
  const parsed = parseExcelNumericCell(raw);
  const d = parsed.replace(/\D/g, '');
  if (d.length === 11) return d;
  if (d.length > 11) return d.slice(-11);
  return '';
}

/**
 * @param {unknown} raw
 * @returns {string}
 */
export function phoneDigitsFromExcelCell(raw) {
  const parsed = parseExcelNumericCell(raw);
  let d = parsed.replace(/\D/g, '');
  if (d.length >= 12 && d.startsWith('55')) d = d.slice(2);
  return d;
}
