import { unzipSync } from 'fflate';
import { xlsxBufferToRowObjects, csvTextToRowObjectsFast } from './spreadsheetToObjects.js';
import { normalizeRgmCanonical } from './rgmDisplay.js';
import {
  cpfDigitsFromSiaaRow,
  siaaRematriculaRowQuality,
} from './siaaRematriculaRepair.js';

const SPREADSHEET_EXT = /\.(xlsx|xls|xlsm|xlsb|ods|csv|tsv|txt)$/i;

/**
 * @param {Buffer} buffer
 * @param {string} [fileName]
 */
export function isZipBuffer(buffer, fileName = '') {
  if (/\.zip$/i.test(fileName)) return true;
  return false;
}

/**
 * @param {Buffer} buffer
 * @returns {{ name: string, buffer: Buffer }[]}
 */
export function extractSpreadsheetEntriesFromZip(buffer) {
  const u8 = new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength);
  const all = unzipSync(u8);
  return Object.entries(all)
    .filter(([name, data]) => !name.endsWith('/') && data?.length && SPREADSHEET_EXT.test(name))
    .map(([name, data]) => ({ name, buffer: Buffer.from(data) }))
    .sort((a, b) => a.name.localeCompare(b.name, 'pt-BR'));
}

/**
 * @param {Record<string, string>} row
 */
function rowIdentityKey(row) {
  const rgm = normalizeRgmCanonical(
    row.RGM_ALUN || row.RGM || row['RGM Aluno'] || row['RGM_ALUNO'] || ''
  );
  if (rgm) return `rgm:${rgm}`;
  const cpf = cpfDigitsFromSiaaRow(row);
  if (cpf) return `cpf:${cpf}`;
  return '';
}

/**
 * Mantém a linha com mais dados úteis (RGM válido > linha parcial de outro XLSM no ZIP).
 * @param {Record<string, string>[]} rows
 */
export function dedupeRowsByIdentity(rows) {
  const map = new Map();
  for (const row of rows) {
    const key = rowIdentityKey(row);
    if (!key) continue;
    const existing = map.get(key);
    if (!existing || siaaRematriculaRowQuality(row) > siaaRematriculaRowQuality(existing)) {
      map.set(key, row);
    }
  }
  return [...map.values()];
}

/**
 * @param {Record<string, string>[]} rows
 */
export function filterSiaaInadimplenteRows(rows) {
  return rows.filter((row) => /^inadimplente$/i.test(String(row.SIT_FINAN ?? '').trim()));
}

/** @param {Record<string, string>} row */
function siaaSitAtualFromRow(row) {
  return String(row.SIT_ATUAL ?? row.Sit_Atual ?? '').trim().toUpperCase();
}

/**
 * @param {Record<string, string>[]} rows
 */
export function filterSiaaEmCursoRows(rows) {
  return rows.filter((row) => siaaSitAtualFromRow(row) === 'EM CURSO');
}

/**
 * @param {Record<string, string>[]} rows
 * @param {string} [logPrefix]
 */
function applySiaaRematriculaRowFilters(rows, logPrefix = '[siaa]') {
  const beforeSit = rows.length;
  const out = filterSiaaEmCursoRows(rows);
  if (beforeSit !== out.length) {
    console.log(
      `${logPrefix} filtro SIT_ATUAL=EM CURSO: ${beforeSit.toLocaleString('pt-BR')} → ${out.length.toLocaleString('pt-BR')}`
    );
  }
  return out;
}

/**
 * @param {Buffer} buffer
 * @param {string} fileName
 * @param {{ siaaInadimplenteOnly?: boolean }} [opts]
 * @returns {Record<string, string>[]}
 */
export function zipBufferToRowObjects(buffer, fileName, opts = {}) {
  const entries = extractSpreadsheetEntriesFromZip(buffer);
  if (!entries.length) {
    const err = new Error('ZIP sem arquivos CSV/XLSX reconhecíveis.');
    err.status = 400;
    throw err;
  }
  /** @type {Record<string, string>[]} */
  let all = [];
  for (const entry of entries) {
    const isXlsx = /\.(xlsx|xls|xlsm|xlsb|ods)$/i.test(entry.name);
    const rows = isXlsx
      ? xlsxBufferToRowObjects(entry.buffer, entry.name)
      : csvTextToRowObjectsFast(entry.buffer.toString('utf8'));
    all.push(...rows);
  }
  const beforeDedupe = all.length;
  all = dedupeRowsByIdentity(all);
  console.log(
    `[siaa-zip] ${fileName}: ${entries.length} arquivo(s), ${beforeDedupe.toLocaleString('pt-BR')} linhas → ${all.length.toLocaleString('pt-BR')} únicas`
  );
  if (opts.siaaInadimplenteOnly) {
    all = applySiaaRematriculaRowFilters(all, '[siaa-zip]');
  }
  return all;
}

/**
 * @param {Buffer} buffer
 * @param {string} fileName
 * @param {{ siaaSource?: boolean }} [opts]
 */
export function bufferToRowObjectsForUpload(buffer, fileName, opts = {}) {
  if (isZipBuffer(buffer, fileName)) {
    return zipBufferToRowObjects(buffer, fileName, {
      siaaInadimplenteOnly: opts.siaaSource === true,
    });
  }
  const isXlsx = /\.(xlsx|xls|xlsm|xlsb|ods)$/i.test(fileName);
  let rows = isXlsx
    ? xlsxBufferToRowObjects(buffer, fileName)
    : csvTextToRowObjectsFast(buffer.toString('utf8'));
  if (opts.siaaSource) {
    rows = applySiaaRematriculaRowFilters(rows);
  }
  return rows;
}
