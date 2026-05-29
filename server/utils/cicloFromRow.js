/** Colunas comuns de ciclo/turma nas planilhas importadas. */
export const CICLO_COLUMN_KEYS = [
  'Ciclo',
  'ciclo',
  'CICLO',
  'Ciclo Letivo',
  'Ciclo letivo',
  'Ciclo Acadêmico',
  'Ciclo Academico',
  'Turma',
  'turma',
  'Período',
  'Periodo',
  'periodo',
];

/**
 * @param {Record<string, unknown>} row
 * @returns {string}
 */
export function extractCicloFromRow(row) {
  for (const k of CICLO_COLUMN_KEYS) {
    const v = String(row[k] ?? '').trim();
    if (v) return v;
  }
  return '';
}

/**
 * Normaliza para comparação (2026.1 ≈ 2026/1).
 * @param {unknown} raw
 * @returns {string} vazio se inválido
 */
export function normalizeCiclo(raw) {
  let s = String(raw ?? '').trim();
  if (!s) return '';
  s = s.replace(/\s+/g, ' ');
  s = s.replace(/(\d{4})[.\-_](\d)/g, '$1/$2');
  return s;
}

/**
 * @param {Record<string, unknown>} row
 * @returns {string}
 */
export function cicloFromRow(row) {
  return normalizeCiclo(extractCicloFromRow(row));
}

/**
 * @param {Set<string>} a
 * @param {Set<string>} b
 * @returns {'aligned'|'missing'|'divergent'}
 */
export function compareCicloSets(a, b) {
  if (!a.size || !b.size) return 'missing';
  for (const x of a) {
    if (b.has(x)) return 'aligned';
  }
  return 'divergent';
}
