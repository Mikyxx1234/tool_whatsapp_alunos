import { execFileSync } from 'child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { isRgmColumnKey, normalizeRgmCanonical } from './rgmDisplay.js';

/**
 * Export ERP com !ref inválido (ex.: "1:K6910") e células sem endereço A1/B1…
 * O Excel exibe certo; o SheetJS desloca colunas (RGM vira valor).
 * @param {Buffer} buffer
 * @param {string} entryPath
 */
export function readXlsxEntryXml(buffer, entryPath = 'xl/worksheets/sheet1.xml') {
  const dir = mkdtempSync(join(tmpdir(), 'xlsx-'));
  const zipPath = join(dir, 'work.zip');
  const outDir = join(dir, 'out');
  try {
    writeFileSync(zipPath, buffer);
    mkdirSync(outDir);
    const ps = `Expand-Archive -LiteralPath '${zipPath.replace(/'/g, "''")}' -DestinationPath '${outDir.replace(/'/g, "''")}' -Force`;
    execFileSync('powershell', ['-NoProfile', '-Command', ps], { stdio: 'pipe' });
    return readFileSync(join(outDir, ...entryPath.split('/')), 'utf8');
  } finally {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }
}

/**
 * @param {string} rowXml
 * @returns {string[]}
 */
export function cellsFromRowXml(rowXml) {
  /** @type {string[]} */
  const cells = [];
  const cellRe = /<x:c[^>]*>([\s\S]*?)<\/x:c>/g;
  let m;
  while ((m = cellRe.exec(rowXml))) {
    const inner = m[1];
    const t = /<x:t[^>]*>([^<]*)<\/x:t>/.exec(inner);
    const v = /<x:v>([^<]*)<\/x:v>/.exec(inner);
    cells.push(t ? t[1].trim() : v ? String(v[1]).trim() : '');
  }
  return cells;
}

/**
 * @param {Buffer} buffer
 * @param {string} [sheetXmlPath]
 * @returns {Record<string, string>[]}
 */
export function brokenExportXlsxToRowObjects(buffer, sheetXmlPath = 'xl/worksheets/sheet1.xml') {
  const xml = readXlsxEntryXml(buffer, sheetXmlPath);
  const rowXmls = [...xml.matchAll(/<x:row[^>]*>([\s\S]*?)<\/x:row>/g)].map((x) => x[1]);
  if (rowXmls.length < 2) return [];

  const headers = cellsFromRowXml(rowXmls[0]).map((h) => h.trim());
  /** @type {Record<string, string>[]} */
  const objects = [];

  for (let i = 1; i < rowXmls.length; i += 1) {
    const cells = cellsFromRowXml(rowXmls[i]);
    /** @type {Record<string, string>} */
    const o = {};
    let empty = true;
    for (let c = 0; c < headers.length; c += 1) {
      const key = headers[c] || `col_${c}`;
      let val = String(cells[c] ?? '').trim();
      if (val) empty = false;
      if (isRgmColumnKey(key)) {
        const canon = normalizeRgmCanonical(val);
        val = canon || val;
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
