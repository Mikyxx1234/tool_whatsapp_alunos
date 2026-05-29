/** Mesma regra do servidor: RGM = 8 dígitos numéricos. */

const ERP_MAT_CANON_PREFIXES = new Set(['08', '09', '10', '11', '12', '13']);

export function isLikelyErpMatriculaRgm(rawOrCanon: unknown): boolean {
  const s = String(rawOrCanon ?? '').trim();
  if (!s) return false;
  if (/^\+\d{4,7}-\d{2}$/.test(s)) return true;
  if (/^\d{8}$/.test(s) && ERP_MAT_CANON_PREFIXES.has(s.slice(0, 2))) return true;
  return false;
}

export function recoverFinanceiroDecimalRgm(s: string): string | null {
  const m = s.match(/^(\d{1,4})\.(\d{1,2})$/);
  if (!m) return null;
  const n = parseFloat(s);
  if (!Number.isFinite(n) || n >= 10000) return null;
  const v = Math.round(n * 100_000);
  if (v >= 10_000_000 && v <= 99_999_999) return String(v);
  if (v >= 1_000_000 && v <= 9_999_999) return String(v).padStart(8, '0');
  return null;
}

export function normalizeRgmCanonical(raw: unknown): string {
  const s = String(raw ?? '').trim();
  if (!s) return '';
  if (/^\d{8}$/.test(s)) return s;
  const fromDecimal = recoverFinanceiroDecimalRgm(s);
  if (fromDecimal && /^\d{8}$/.test(fromDecimal)) return fromDecimal;
  const digits = s.replace(/\D/g, '');
  if (!digits) return '';
  if (digits.length === 8) return digits;
  if (digits.length === 7) return digits.padStart(8, '0');
  if (digits.length > 8) return digits.slice(-8);
  if (digits.length >= 5) return digits.padStart(8, '0');
  return '';
}

const RGM_KEYS = /^rgm$|^matr[ií]cula$/i;

export function normalizeRowRgms<T extends Record<string, string>>(row: T): T {
  const out = { ...row };
  for (const [key, val] of Object.entries(row)) {
    if (!RGM_KEYS.test(key.trim())) continue;
    const canon = normalizeRgmCanonical(val);
    if (canon) (out as Record<string, string>)[key] = canon;
  }
  return out;
}
