const NAME_KEYS = ['Nome', 'Aluno', 'nome', 'aluno', 'NOME', 'ALUNO'];

/**
 * @param {unknown} v
 * @returns {string}
 */
export function normalizePersonName(v) {
  return String(v ?? '')
    .trim()
    .toUpperCase()
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .replace(/\s+/g, ' ');
}

/**
 * @param {Record<string, unknown>} row
 * @returns {string}
 */
export function personNameFromRow(row) {
  for (const k of NAME_KEYS) {
    const n = normalizePersonName(row[k]);
    if (n.length >= 8) return n;
  }
  return '';
}
