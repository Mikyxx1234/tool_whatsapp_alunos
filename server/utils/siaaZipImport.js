import { unzipSync } from 'fflate';
import { xlsxBufferToRowObjects, csvTextToRowObjectsFast } from './spreadsheetToObjects.js';
import { normalizeRgmCanonical } from './rgmDisplay.js';

const SPREADSHEET_EXT = /\.(xlsx|xls|xlsm|xlsb|ods|csv|tsv|txt)$/i;

/**
 * @param {Buffer} buffer
 * @param {string} [fileName]
 */
export function isZipBuffer(buffer, fileName = '') {
  if (/\.zip$/i.test(fileName)) return true;
  // XLSX/XLSM também são ZIP internamente — não usar magic bytes PK sem extensão .zip
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
  const cpf = String(row.CPF_ALUN || row.CPF || row['CPF Aluno'] || '')
    .replace(/\D/g, '');
  if (cpf.length >= 11) return `cpf:${cpf}`;
  return '';
}

/**
 * @param {Record<string, string>[]} rows
 */
export function dedupeRowsByIdentity(rows) {
  const map = new Map();
  for (const row of rows) {
    const key = rowIdentityKey(row);
    if (!key) continue;
    if (!map.has(key)) map.set(key, row);
  }
  return [...map.values()];
}

/**
 * Export SIAA traz adimplentes e inadimplentes; a base Rematrícula só indexa inadimplentes.
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
 * Coluna F (Sit_Atual) do export SIAA — só alunos em curso entram na base Rematrícula.
 * @param {Record<string, string>[]} rows
 */
export function filterSiaaEmCursoRows(rows) {
  return rows.filter((row) => siaaSitAtualFromRow(row) === 'EM CURSO');
}

/**
 * Upload SIAA na base Rematrícula: só Sit_Atual/SIT_ATUAL = EM CURSO (adimplente e inadimplente).
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
