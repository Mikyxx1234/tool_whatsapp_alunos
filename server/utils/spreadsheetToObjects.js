import * as XLSX from 'xlsx';
import Papa from 'papaparse';
import {
  brokenExportXlsxToRowObjects,
  sheetRefIsBroken,
} from './brokenExportXlsx.js';
import { isRgmColumnKey, normalizeRgmCanonical } from './rgmDisplay.js';

function cellToString(v, opts = {}) {
  if (v === null || v === undefined) return '';
  if (typeof v === 'object' && v !== null) {
    if (opts.preferFormatted && 'w' in v && v.w != null) {
      const w = String(v.w).trim();
      if (w) return w;
    }
    if (opts.preferFormatted && v.t === 'd' && 'v' in v) {
      const formatted = XLSX.utils.format_cell(v);
      if (formatted && formatted.trim()) return formatted.trim();
    }
    if ('w' in v && v.w != null && String(v.w).trim() !== '') {
      return String(v.w).trim();
    }
    if ('v' in v) return cellToString(v.v, opts);
  }
  if (typeof v === 'string') return v;
  if (typeof v === 'number') {
    if (!Number.isFinite(v)) return '';
    if (Number.isInteger(v) && Math.abs(v) < 1e21) return v.toFixed(0);
    const s = String(v);
    if (/^\d+\.\d{1,2}$/.test(s)) {
      const [a, b] = s.split('.');
      return `${a}${b.padEnd(2, '0')}`;
    }
    return s;
  }
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (v instanceof Date) {
    if (Number.isNaN(v.getTime())) return '';
    return v.toISOString().slice(0, 10);
  }
  return String(v);
}

function normalizeRowWidths(rows) {
  if (!rows.length) return rows;
  const maxCols = rows.reduce((max, row) => Math.max(max, row.length), 0);
  if (maxCols === 0) return rows;
  return rows.map((row) => {
    const out = [...row];
    while (out.length < maxCols) out.push('');
    return out;
  });
}

/**
 * Matriz de células preservando {v,w} do Excel (texto formatado do RGM).
 * @param {XLSX.WorkSheet | unknown[][]} sheet
 * @returns {unknown[][]}
 */
function sheetToCellMatrix(sheet) {
  if (Array.isArray(sheet)) {
    return sheet.map((row) => (Array.isArray(row) ? row : []));
  }
  const ref = sheet['!ref'];
  if (!ref) return [];
  const range = XLSX.utils.decode_range(ref);
  const matrix = [];
  for (let r = range.s.r; r <= range.e.r; r += 1) {
    const row = [];
    for (let c = range.s.c; c <= range.e.c; c += 1) {
      const addr = XLSX.utils.encode_cell({ r, c });
      row.push(sheet[addr] ?? '');
    }
    matrix.push(row);
  }
  return matrix;
}

/**
 * @param {Buffer|ArrayBuffer} buffer
 * @param {string} fileName
 * @returns {Record<string, string>[]}
 */
export function xlsxBufferToRowObjects(buffer, fileName) {
  // Exports SIAA/ERP (.xlsm, !ref quebrado): XML direto evita OOM do SheetJS em planilhas grandes.
  if (/\.xlsm$/i.test(fileName)) {
    const fromXml = brokenExportXlsxToRowObjects(buffer);
    if (fromXml.length) {
      console.log(
        `[spreadsheet] ${fileName}: ${fromXml.length.toLocaleString('pt-BR')} linhas (XML SIAA/ERP)`
      );
      return fromXml;
    }
  }

  const wb = XLSX.read(buffer, {
    type: 'buffer',
    cellDates: false,
    cellText: true,
    dense: false,
  });
  let sheetName = wb.SheetNames[0];
  for (const name of wb.SheetNames) {
    const sheet = wb.Sheets[name];
    if (sheet && sheet['!ref']) {
      sheetName = name;
      break;
    }
  }
  const sheet = wb.Sheets[sheetName];

  if (sheetRefIsBroken(sheet)) {
    const objects = brokenExportXlsxToRowObjects(buffer);
    console.log(
      `[spreadsheet] ${fileName}: ${objects.length.toLocaleString('pt-BR')} linhas (export com colunas corrigidas via XML)`
    );
    return objects;
  }

  const matrix = normalizeRowWidths(sheetToCellMatrix(sheet));
  if (!matrix.length) return [];
  const headers = matrix[0].map((h) => cellToString(h).trim());
  const objects = [];
  for (let i = 1; i < matrix.length; i += 1) {
    const row = matrix[i];
    /** @type {Record<string, string>} */
    const o = {};
    let empty = true;
    for (let c = 0; c < headers.length; c += 1) {
      const key = headers[c] || `col_${c}`;
      const isRgm = isRgmColumnKey(key);
      const val = cellToString(row[c], { preferFormatted: isRgm }).trim();
      if (val) empty = false;
      o[key] = isRgm ? normalizeRgmCanonical(val) || val : val;
    }
    if (!empty) objects.push(o);
  }
  console.log(
    `[spreadsheet] ${fileName}: ${objects.length.toLocaleString('pt-BR')} linhas (aba ${sheetName})`
  );
  return objects;
}

/**
 * @param {string} csvText
 * @returns {Record<string, string>[]}
 */
export function csvTextToRowObjectsFast(csvText) {
  const parsed = Papa.parse(String(csvText || ''), {
    header: true,
    skipEmptyLines: 'greedy',
    transformHeader: (h) => String(h ?? '').trim(),
  });
  const fatalErrors = (parsed.errors || []).filter(
    (e) => e.code !== 'TooFewFields' && e.code !== 'TooManyFields'
  );
  if (fatalErrors.length) {
    const msg = fatalErrors.map((e) => e.message).join('; ');
    const err = new Error(`CSV: ${msg}`);
    err.status = 400;
    throw err;
  }
  const data = parsed.data || [];
  return data.map((row) => {
    /** @type {Record<string, string>} */
    const o = {};
    if (row && typeof row === 'object') {
      for (const [k, v] of Object.entries(row)) {
        const isRgm = isRgmColumnKey(k);
        const s = v === null || v === undefined ? '' : String(v).trim();
        o[k] = isRgm ? normalizeRgmCanonical(s) || s : s;
      }
    }
    return o;
  });
}
