/**
 * Gera CSV simples a partir de um array de objetos.
 * - Detecta colunas dinamicamente a partir das chaves (ou aceita lista fixa).
 * - Escapa aspas duplas, vírgulas e quebras de linha (RFC 4180).
 * - Retorna string com BOM UTF-8 para abrir corretamente no Excel BR.
 */

const BOM = '\uFEFF';

function escapeCell(value) {
  if (value === null || value === undefined) return '';
  let str;
  if (value instanceof Date) {
    str = value.toISOString();
  } else if (typeof value === 'object') {
    str = JSON.stringify(value);
  } else {
    str = String(value);
  }
  const needsQuotes = /[",\n\r;]/.test(str);
  if (needsQuotes) {
    str = `"${str.replace(/"/g, '""')}"`;
  }
  return str;
}

export function buildCsv(rows, options = {}) {
  if (!Array.isArray(rows) || rows.length === 0) {
    return BOM + (options.columns?.map((c) => c.header).join(';') || '') + '\n';
  }

  const columns =
    options.columns ||
    Object.keys(rows[0]).map((key) => ({ key, header: key }));

  const header = columns.map((c) => escapeCell(c.header)).join(';');
  const lines = rows.map((row) =>
    columns
      .map((c) => escapeCell(typeof c.value === 'function' ? c.value(row) : row[c.key]))
      .join(';')
  );

  return BOM + [header, ...lines].join('\n') + '\n';
}

export function sanitizeFilename(name) {
  return String(name || 'export')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-zA-Z0-9._-]+/g, '_')
    .slice(0, 80);
}
