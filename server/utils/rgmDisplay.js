/** Colunas que carregam RGM nas planilhas importadas. */
export const RGM_COLUMN_KEYS = new Set(
  [
    'RGM',
    'Rgm',
    'rgm',
    'RGM_ALUN',
    'RGM_ALUNO',
    'Matricula',
    'matricula',
    'MATRICULA',
    'Matrícula',
    'matrícula',
  ].map((k) => k.toLowerCase())
);

/**
 * @param {string} key
 */
export function isRgmColumnKey(key) {
  return RGM_COLUMN_KEYS.has(String(key ?? '').trim().toLowerCase());
}

/**
 * Planilha financeira: Excel exibe 154.04 mas o valor real costuma ser 15404000 (×100000).
 * @param {string} s
 * @returns {string | null}
 */
export function recoverFinanceiroDecimalRgm(s) {
  const m = s.match(/^(\d{1,4})\.(\d{1,2})$/);
  if (!m) return null;
  const n = parseFloat(s);
  if (!Number.isFinite(n) || n >= 10000) return null;
  const v = Math.round(n * 100_000);
  if (v >= 10_000_000 && v <= 99_999_999) return String(v);
  if (v >= 1_000_000 && v <= 9_999_999) return String(v).padStart(8, '0');
  return null;
}

/** Formato ERP de matriculados (+136102-10) — não é o RGM institucional de 8 dígitos. */
const ERP_MATRICULA_PATTERN = /^\+\d{4,7}-\d{2}$/;

/** Prefixos dominantes após conversão errada do formato +XXXXXX-YY na base matriculados. */
const ERP_MAT_CANON_PREFIXES = new Set(['08', '09', '10', '11', '12', '13']);

/**
 * @param {unknown} rawOrCanon
 * @returns {boolean}
 */
export function isLikelyErpMatriculaRgm(rawOrCanon) {
  const s = String(rawOrCanon ?? '').trim();
  if (!s) return false;
  if (ERP_MATRICULA_PATTERN.test(s)) return true;
  if (/^\d{8}$/.test(s) && ERP_MAT_CANON_PREFIXES.has(s.slice(0, 2))) return true;
  return false;
}

/**
 * Modelo oficial: 8 dígitos, só números (ex.: 48501794). Preserva zeros à esquerda.
 * @param {unknown} raw
 * @param {{ allowErpMatricula?: boolean }} [opts]
 * @returns {string} vazio se não for possível normalizar
 */
/**
 * Valor em aberto rotulado como "RGM" (ex.: 1464.23) — não usar como matrícula.
 * @param {unknown} raw
 */
export function isFinanceiroValorAsRgm(raw) {
  const s = String(raw ?? '').trim();
  if (!s) return false;
  if (/^\d{3,5}\.\d{1,2}$/.test(s) && parseFloat(s) >= 100) return true;
  if (/^\d{1,4}$/.test(s) && parseInt(s, 10) < 10_000) return true;
  return false;
}

/**
 * @param {string} canon
 */
export function isPlausibleInstitutionalRgm(canon) {
  if (!/^\d{8}$/.test(canon)) return false;
  const n = parseInt(canon, 10);
  return Number.isFinite(n) && n >= 1_000_000;
}

export function normalizeRgmCanonical(raw) {
  const s = String(raw ?? '').trim();
  if (!s) return '';

  if (isFinanceiroValorAsRgm(s)) return '';

  if (/^\d{8}$/.test(s)) return s;

  if (/^\d{1,4}\.\d{1,2}$/.test(s)) {
    const fromDecimal = recoverFinanceiroDecimalRgm(s);
    return fromDecimal && /^\d{8}$/.test(fromDecimal) ? fromDecimal : '';
  }

  const fromDecimal = recoverFinanceiroDecimalRgm(s);
  if (fromDecimal && /^\d{8}$/.test(fromDecimal)) return fromDecimal;

  const digits = s.replace(/\D/g, '');
  if (!digits) return '';

  if (digits.length === 8) return digits;
  if (digits.length === 7) return digits.padStart(8, '0');
  if (digits.length > 8) return digits.slice(-8);
  if (digits.length >= 6) return digits.padStart(8, '0');

  return '';
}

/**
 * Matriculados: preserva token ERP em RGM_erp_matricula; RGM fica vazio até cruzar com financeiro.
 * @param {Record<string, unknown>} row
 * @returns {Record<string, unknown>}
 */
export function normalizeMatriculadosRowRgms(row) {
  if (!row || typeof row !== 'object') return row;
  /** @type {Record<string, unknown>} */
  const out = { ...row };
  for (const [key, val] of Object.entries(row)) {
    if (!isRgmColumnKey(key)) continue;
    const raw = String(val ?? '').trim();
    if (!raw) continue;
    if (isLikelyErpMatriculaRgm(raw)) {
      if (!out.RGM_erp_matricula) out.RGM_erp_matricula = raw;
      out[key] = '';
      continue;
    }
    const canon = normalizeRgmCanonical(raw);
    if (canon) out[key] = canon;
  }
  return out;
}

/**
 * @param {Record<string, unknown>} row
 * @returns {Record<string, unknown>}
 */
export function normalizeRowRgms(row) {
  if (!row || typeof row !== 'object') return row;
  /** @type {Record<string, unknown>} */
  const out = { ...row };
  for (const [key, val] of Object.entries(row)) {
    if (!isRgmColumnKey(key)) continue;
    const canon = normalizeRgmCanonical(val);
    if (canon) out[key] = canon;
  }
  return out;
}

/**
 * Planilha "mensalidade em aberto": 1ª coluna vem como "RGM" mas é valor (1464.23).
 * @param {Record<string, unknown>} row
 * @param {{ rgmColumnIsValor?: boolean }} [opts]
 */
export function normalizeFinanceiroRow(row, opts = {}) {
  if (!row || typeof row !== 'object') return row;
  /** @type {Record<string, unknown>} */
  const out = { ...row };
  for (const [key, val] of Object.entries(row)) {
    if (!isRgmColumnKey(key)) continue;
    const raw = String(val ?? '').trim();
    if (!raw) continue;
    if (opts.rgmColumnIsValor || isFinanceiroValorAsRgm(raw)) {
      if (!out.Valor_devido && !out.Valor) out.Valor_devido = raw;
      out[key] = '';
      continue;
    }
    const canon = normalizeRgmCanonical(raw);
    if (canon && isPlausibleInstitutionalRgm(canon)) out[key] = canon;
    else out[key] = '';
  }
  return out;
}

/**
 * @param {Record<string, unknown>[]} objects
 */
export function detectFinanceiroRgmColumnIsValor(objects) {
  if (!objects.length) return false;
  let valorLike = 0;
  let plausible = 0;
  const sample = objects.slice(0, Math.min(400, objects.length));
  for (const row of sample) {
    const raw = rgmRawFromRow(row);
    if (!raw) continue;
    if (isFinanceiroValorAsRgm(raw)) valorLike += 1;
    else {
      const c = normalizeRgmCanonical(raw);
      if (isPlausibleInstitutionalRgm(c)) plausible += 1;
    }
  }
  return valorLike > 0 && valorLike >= plausible;
}

/**
 * @param {Record<string, unknown>} row
 */
export function rgmRawFromRow(row) {
  for (const key of Object.keys(row)) {
    if (!isRgmColumnKey(key)) continue;
    const v = row[key];
    if (v !== null && v !== undefined && String(v).trim() !== '') {
      return String(v).trim();
    }
  }
  return '';
}

/** @deprecated use normalizeRgmCanonical */
export function formatRgmForDisplay(raw) {
  return normalizeRgmCanonical(raw);
}

/**
 * @param {Record<string, unknown>} row
 */
/** RGM de planilhas institucionais (docs, evasão…). */
export function displayRgmFromRow(row) {
  const canon = normalizeRgmCanonical(rgmRawFromRow(row));
  return isPlausibleInstitutionalRgm(canon) ? canon : '';
}

/** RGM na base matriculados (ignora token ERP +136102-10 / 13xxxxxx convertido). */
export function displayRgmFromMatriculadosRow(row) {
  const raw = rgmRawFromRow(row);
  if (isLikelyErpMatriculaRgm(raw)) return '';
  return normalizeRgmCanonical(raw);
}

/**
 * Exibição/cruzamento: docs/evasão usam RGM da pendência; financeiro usa matriculados
 * (a coluna "RGM" da mensalidade em aberto é valor devido, não matrícula).
 * @param {Record<string, unknown>} [matRow]
 * @param {Record<string, unknown>} [otherRow]
 * @param {string} [otherCategory]
 */
export function pickDisplayRgm(matRow, otherRow, otherCategory) {
  if (otherRow) {
    const fromOther = displayRgmFromRow(otherRow);
    if (fromOther) return fromOther;
  }
  if (!matRow) return '';
  return displayRgmFromMatriculadosRow(matRow);
}
