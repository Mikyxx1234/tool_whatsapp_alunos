import { unzipSync, strFromU8 } from 'fflate';
import * as XLSX from 'xlsx';
import { parseExcelNumericCell } from './excelNumericCell.js';
import { isRgmColumnKey, normalizeRgmCanonical, importRgmCellValue } from './rgmDisplay.js';

/**
 * Export ERP com !ref inválido (ex.: "1:K6910") e células sem endereço A1/B1…
 * O Excel exibe certo; o SheetJS desloca colunas (RGM vira valor).
 *
 * Implementação cross-platform via fflate (JS puro). Antes usava PowerShell
 * Expand-Archive, mas isso quebrava na produção Linux (Easypanel) com
 * `spawnSync powershell ENOENT`.
 * @param {Buffer | ArrayBuffer | Uint8Array} buffer
 * @param {string} entryPath
 */
export function readXlsxEntryXml(buffer, entryPath = 'xl/worksheets/sheet1.xml') {
  const u8 =
    buffer instanceof Uint8Array
      ? buffer
      : buffer instanceof ArrayBuffer
        ? new Uint8Array(buffer)
        : new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength);
  const files = unzipSync(u8, { filter: (f) => f.name === entryPath });
  const entry = files[entryPath];
  if (!entry) {
    throw new Error(`XLSX sem entrada "${entryPath}"`);
  }
  return strFromU8(entry);
}

/**
 * @param {Buffer | ArrayBuffer | Uint8Array} buffer
 * @returns {string[]}
 */
function readSharedStrings(buffer) {
  try {
    const xml = readXlsxEntryXml(buffer, 'xl/sharedStrings.xml');
    /** @type {string[]} */
    const strings = [];
    const siRe = /<(?:\w+:)?si[^>]*>([\s\S]*?)<\/(?:\w+:)?si>/g;
    let m;
    while ((m = siRe.exec(xml))) {
      const inner = m[1];
      const parts = [...inner.matchAll(/<(?:\w+:)?t[^>]*>([^<]*)<\/(?:\w+:)?t>/g)].map((x) => x[1]);
      strings.push(parts.join('').trim());
    }
    return strings;
  } catch {
    return [];
  }
}

/**
 * @param {string} cellXml
 * @param {string[]} sharedStrings
 * @returns {string}
 */
function cellValueFromXml(cellXml, sharedStrings) {
  const tMatch = /\bt="([^"]+)"/.exec(cellXml);
  const t = tMatch ? tMatch[1] : '';
  if (t === 'inlineStr') {
    const parts = [...cellXml.matchAll(/<(?:\w+:)?t[^>]*>([^<]*)<\/(?:\w+:)?t>/g)].map(
      (x) => x[1]
    );
    return parts.join('').trim();
  }
  const vMatch = /<(?:\w+:)?v>([^<]*)<\/(?:\w+:)?v>/.exec(cellXml);
  const v = vMatch ? String(vMatch[1]).trim() : '';
  if (t === 's' && v !== '') {
    const idx = parseInt(v, 10);
    return Number.isFinite(idx) ? String(sharedStrings[idx] ?? '').trim() : '';
  }
  if (t === 'b') return v === '1' ? 'true' : v === '0' ? 'false' : v;
  if (/^[+-]?\d*\.?\d+([eE][+-]?\d+)?$/.test(v)) {
    return parseExcelNumericCell(v);
  }
  return v;
}

/**
 * @param {string} ref — ex. "A3", "BC12"
 * @returns {number} índice 0-based da coluna, ou -1
 */
function colIndexFromCellRef(ref) {
  const m = /^([A-Za-z]+)/.exec(String(ref ?? '').trim());
  if (!m) return -1;
  let col = 0;
  for (const ch of m[1].toUpperCase()) {
    col = col * 26 + (ch.charCodeAt(0) - 64);
  }
  return col - 1;
}

/**
 * @param {string} rowXml
 * @param {string[]} sharedStrings
 * @returns {string[]}
 */
export function cellsFromRowXml(rowXml, sharedStrings = []) {
  const cellRe = /<(?:\w+:)?c\b([^>]*)>[\s\S]*?<\/(?:\w+:)?c>/g;
  /** @type {Map<number, string>} */
  const byCol = new Map();
  let maxCol = -1;
  let seq = 0;
  let m;
  while ((m = cellRe.exec(rowXml))) {
    const attrs = m[1];
    const rMatch = /\br="([^"]+)"/.exec(attrs);
    let colIdx = rMatch ? colIndexFromCellRef(rMatch[1]) : seq;
    if (colIdx < 0) colIdx = seq;
    const val = cellValueFromXml(m[0], sharedStrings);
    byCol.set(colIdx, val);
    if (colIdx > maxCol) maxCol = colIdx;
    seq += 1;
  }
  if (maxCol < 0) return [];
  const cells = [];
  for (let c = 0; c <= maxCol; c += 1) {
    cells.push(byCol.get(c) ?? '');
  }
  return cells;
}

/**
 * @param {string[]} cells
 */
function looksLikeHeaderRow(cells) {
  const joined = cells.map((c) => String(c).trim()).filter(Boolean);
  if (joined.length < 3) return false;
  const upper = joined.join('|').toUpperCase();
  if (/RGM|CPF|EMPRESA|INSTITUICAO|NOME/.test(upper)) return true;
  if (/POLO|MENSALIDADE|VENCIMENTO|SIT_FINAN/.test(upper)) return true;
  return false;
}

/**
 * @param {string[]} rowXmls
 * @param {string[]} sharedStrings
 */
function findHeaderRowIndex(rowXmls, sharedStrings) {
  if (rowXmls.length >= 1) {
    const h0 = cellsFromRowXml(rowXmls[0], sharedStrings);
    if (looksLikeHeaderRow(h0)) return 0;
  }
  const limit = Math.min(rowXmls.length, 12);
  for (let i = 1; i < limit; i += 1) {
    const cells = cellsFromRowXml(rowXmls[i], sharedStrings);
    if (looksLikeHeaderRow(cells)) return i;
  }
  return 0;
}

/**
 * Extrai conteúdo interno de cada <row> sem regex global no XML inteiro (evita OOM em exports SIAA ~9MB).
 * @param {string} xml
 * @returns {string[]}
 */
function extractRowInners(xml) {
  /** @type {string[]} */
  const inners = [];
  const openRe = /<(?:\w+:)?row\b[^>]*>/g;
  let m;
  while ((m = openRe.exec(xml)) !== null) {
    const start = m.index + m[0].length;
    const closeRe = /<\/(?:\w+:)?row>/g;
    closeRe.lastIndex = start;
    const cm = closeRe.exec(xml);
    if (!cm) break;
    inners.push(xml.slice(start, cm.index));
    openRe.lastIndex = cm.index + cm[0].length;
  }
  return inners;
}

/**
 * @param {Buffer} buffer
 * @param {string} [sheetXmlPath]
 * @returns {Record<string, string>[]}
 */
export function brokenExportXlsxToRowObjects(buffer, sheetXmlPath = 'xl/worksheets/sheet1.xml') {
  const sharedStrings = readSharedStrings(buffer);
  const xml = readXlsxEntryXml(buffer, sheetXmlPath);
  const rowXmls = extractRowInners(xml);
  if (rowXmls.length < 2) return [];

  const headerIdx = findHeaderRowIndex(rowXmls, sharedStrings);
  const headers = cellsFromRowXml(rowXmls[headerIdx], sharedStrings).map((h) => h.trim());
  /** @type {Record<string, string>[]} */
  const objects = [];

  for (let i = headerIdx + 1; i < rowXmls.length; i += 1) {
    const cells = cellsFromRowXml(rowXmls[i], sharedStrings);
    /** @type {Record<string, string>} */
    const o = {};
    let empty = true;
    for (let c = 0; c < headers.length; c += 1) {
      const key = headers[c] || `col_${c}`;
      let val = String(cells[c] ?? '').trim();
      if (val) empty = false;
      if (isRgmColumnKey(key)) {
        val = importRgmCellValue(val);
      }
      o[key] = val;
    }
    if (!empty) objects.push(o);
  }
  return objects;
}

/**
 * @param {import('xlsx').WorkSheet} sheet
 */
export function sheetRefIsBroken(sheet) {
  if (!sheet || Array.isArray(sheet)) return false;
  const ref = sheet['!ref'];
  if (!ref) return true;
  try {
    const range = XLSX.utils.decode_range(ref);
    return range.s.c < 0;
  } catch {
    return true;
  }
}
