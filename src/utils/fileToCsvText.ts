import * as XLSX from 'xlsx';
import { normalizeRgmCanonical } from './rgmNormalize';

const XLSX_EXT = /\.(xlsx|xls|xlsm|xlsb|ods)$/i;
const CSV_EXT = /\.(csv|txt|tsv)$/i;

export type SupportedFileKind = 'csv' | 'xlsx' | 'unknown';

export function detectFileKind(file: File): SupportedFileKind {
  if (XLSX_EXT.test(file.name)) return 'xlsx';
  if (CSV_EXT.test(file.name)) return 'csv';
  const mime = (file.type || '').toLowerCase();
  if (mime.includes('spreadsheet') || mime.includes('excel')) return 'xlsx';
  if (mime.includes('csv') || mime.includes('text/plain')) return 'csv';
  return 'unknown';
}

export function isSupportedFile(file: File): boolean {
  return detectFileKind(file) !== 'unknown';
}

function readAsText(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result || ''));
    r.onerror = () => reject(r.error || new Error('Falha ao ler arquivo'));
    r.readAsText(file, 'utf-8');
  });
}

function readAsArrayBuffer(file: File): Promise<ArrayBuffer> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(r.result as ArrayBuffer);
    r.onerror = () => reject(r.error || new Error('Falha ao ler arquivo'));
    r.readAsArrayBuffer(file);
  });
}

/**
 * Serializa um valor de célula como string preservando dígitos integrais
 * (evita notação científica em telefones, CPFs, RGM etc.).
 */
function cellToString(v: unknown): string {
  if (v === null || v === undefined) return '';
  if (typeof v === 'string') return v;
  if (typeof v === 'number') {
    if (!Number.isFinite(v)) return '';
    // Inteiro: imprime sem casas decimais nem notação científica
    if (Number.isInteger(v)) {
      // Para números até 2^53, toString não usa notação científica
      // exceto extremos. Para garantir, usamos toFixed(0).
      if (Math.abs(v) < 1e21) return v.toFixed(0);
      return String(v);
    }
    return String(v);
  }
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (v instanceof Date) {
    if (Number.isNaN(v.getTime())) return '';
    return v.toISOString().slice(0, 10);
  }
  return String(v);
}

function escapeCsvField(s: string): string {
  if (s === '') return '';
  if (/[",\r\n]/.test(s)) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}

/** Garante que todas as linhas tenham o mesmo número de colunas (evita TooFewFields no Papa Parse). */
function normalizeRowWidths(rows: unknown[][]): unknown[][] {
  if (!rows.length) return rows;
  const maxCols = rows.reduce((max, row) => Math.max(max, row.length), 0);
  if (maxCols === 0) return rows;
  return rows.map((row) => {
    const out = [...row];
    while (out.length < maxCols) out.push('');
    return out;
  });
}

const RGM_HEADER = /^rgm$|^matr[ií]cula$/i;

function rgmColumnIndices(headerRow: unknown[]): Set<number> {
  const out = new Set<number>();
  headerRow.forEach((cell, i) => {
    const h = cellToString(cell).trim();
    if (h && RGM_HEADER.test(h)) out.add(i);
  });
  return out;
}

function aoaToCsv(rows: unknown[][]): string {
  const normalized = normalizeRowWidths(rows);
  const rgmCols =
    normalized.length > 0 ? rgmColumnIndices(normalized[0]) : new Set<number>();

  return normalized
    .map((row, rowIdx) =>
      row
        .map((c, colIdx) => {
          let s = cellToString(c);
          if (rowIdx > 0 && rgmCols.has(colIdx)) {
            const canon = normalizeRgmCanonical(s);
            if (canon) s = canon;
          }
          return escapeCsvField(s);
        })
        .join(',')
    )
    .join('\n');
}

type XlsxCell = { v?: unknown; w?: string };

function denseCellValue(cell: unknown, preferFormatted = false): unknown {
  if (cell == null || cell === '') return '';
  if (typeof cell === 'object' && cell !== null) {
    const c = cell as XlsxCell;
    if (preferFormatted && c.w != null && String(c.w).trim() !== '') return c.w;
    if ('w' in c && c.w != null && String(c.w).trim() !== '') return c.w;
    if ('v' in c) return c.v;
  }
  return cell;
}

/** Planilhas exportadas por alguns ERPs usam !ref inválido (ex.: "1:K6910" → coluna -1). */
function sheetRefIsBroken(sheet: XLSX.WorkSheet): boolean {
  const ref = sheet['!ref'];
  if (!ref) return true;
  try {
    const range = XLSX.utils.decode_range(ref);
    return range.s.c < 0 || range.s.r < 0 || range.e.c < range.s.c;
  } catch {
    return true;
  }
}

function rowsFromDenseSheet(sheet: unknown): unknown[][] {
  if (!Array.isArray(sheet)) {
    throw new Error('Planilha em formato não suportado.');
  }
  const matrix = sheet as unknown[][];
  const header = Array.isArray(matrix[0]) ? matrix[0].map((c) => denseCellValue(c)) : [];
  const rgmCols = rgmColumnIndices(header);
  return matrix
    .map((row, rowIdx) => {
      if (!Array.isArray(row)) return [];
      return row.map((cell, colIdx) => {
        const preferFmt = rowIdx > 0 && rgmCols.has(colIdx);
        return denseCellValue(cell, preferFmt);
      });
    })
    .filter((row) => row.some((c) => cellToString(c) !== ''));
}

function rowsFromSparseWorksheet(sheet: XLSX.WorkSheet): unknown[][] {
  if (sheetRefIsBroken(sheet)) {
    throw new Error(
      'Planilha XLSX com referência inválida. Reexporte o arquivo ou salve como CSV.'
    );
  }
  return XLSX.utils.sheet_to_json<unknown[]>(sheet, {
    header: 1,
    raw: true,
    defval: '',
    blankrows: false,
  });
}

function worksheetToRows(sheet: XLSX.WorkSheet | unknown[][]): unknown[][] {
  if (Array.isArray(sheet)) {
    return rowsFromDenseSheet(sheet);
  }
  try {
    return rowsFromSparseWorksheet(sheet);
  } catch (err) {
    const msg = err instanceof Error ? err.message : '';
    if (!msg.includes('invalid column')) {
      throw err;
    }
    throw new Error(
      'Planilha XLSX com formato não suportado (referência de colunas inválida). Tente salvar como CSV no Excel.'
    );
  }
}

/**
 * Converte um arquivo CSV/XLSX em texto CSV (UTF-8, separador `,`).
 *
 * - CSV: retorna o conteúdo cru.
 * - XLSX: pega a primeira aba com dados e exporta como CSV preservando
 *   dígitos integrais (importante para telefone/CPF que podem virar
 *   notação científica se o Excel formatou como "número").
 */
export async function fileToCsvText(file: File): Promise<string> {
  const kind = detectFileKind(file);

  if (kind === 'csv') {
    return readAsText(file);
  }

  if (kind === 'xlsx') {
    const buf = await readAsArrayBuffer(file);
    // dense: true — necessário para exports com !ref quebrado (ex. mensalidade em aberto)
    const wb = XLSX.read(buf, {
      type: 'array',
      cellDates: false,
      cellText: true,
      cellNF: false,
      dense: true,
    });
    if (!wb.SheetNames.length) {
      throw new Error('Planilha vazia: nenhuma aba encontrada.');
    }
    let sheetName = wb.SheetNames[0];
    for (const name of wb.SheetNames) {
      const s = wb.Sheets[name];
      if (s && (Array.isArray(s) ? s.length > 0 : s['!ref'])) {
        sheetName = name;
        break;
      }
    }
    const sheet = wb.Sheets[sheetName];
    const rows = worksheetToRows(sheet as XLSX.WorkSheet | unknown[][]);
    if (!rows.length) {
      throw new Error('Planilha vazia ou sem linhas de dados.');
    }
    return aoaToCsv(rows);
  }

  throw new Error(
    `Formato de arquivo não suportado (${file.name}). Use CSV ou XLSX.`
  );
}
