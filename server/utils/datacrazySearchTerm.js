import { phoneDigitsFromExcelCell } from './excelNumericCell.js';

/** Textos de placeholder comuns em exports SIAA/Excel — nunca devem ir pra API. */
const PLACEHOLDER_TEXT =
  /(?:^|\b)(?:n[aã]?o\s*)?encontrado(?:\b|$)|not\s*found|sem\s*(?:telefone|celular|e-?mail)|^(?:null|undefined|n\/a|—|-)$/i;

/**
 * @param {unknown} value
 */
export function isPlaceholderContact(value) {
  const s = String(value ?? '').trim();
  if (!s) return true;
  if (PLACEHOLDER_TEXT.test(s)) return true;
  // Ex.: "55 não encontrado", "55n encontrado" (telefone ausente no SIAA)
  if (/55\s*n/i.test(s) && !s.includes('@')) return true;
  if (/encontrado|not\s*found/i.test(s) && !s.includes('@')) return true;
  return false;
}

/**
 * Normaliza telefone para lookup no CRM (10–11 dígitos locais, sem lixo).
 * @param {unknown} raw
 * @returns {string}
 */
export function sanitizeContactPhone(raw) {
  if (isPlaceholderContact(raw)) return '';
  const digits = phoneDigitsFromExcelCell(raw);
  if (digits.length < 10 || digits.length > 11) return '';
  return digits;
}

/**
 * @param {unknown} raw
 * @returns {string}
 */
export function sanitizeContactEmail(raw) {
  const s = String(raw ?? '').trim().toLowerCase();
  if (!s || isPlaceholderContact(s)) return '';
  if (s.length < 6 || !s.includes('@')) return '';
  const [local, domain] = s.split('@');
  if (!local || !domain || !domain.includes('.')) return '';
  return s;
}

/**
 * Termo seguro para `?search=` na API DataCrazy (CPF, telefone ou e-mail).
 * @param {unknown} term
 */
export function isValidDatacrazySearchTerm(term) {
  const s = String(term ?? '').trim();
  if (!s || s.length > 120) return false;
  if (isPlaceholderContact(s)) return false;

  const digits = s.replace(/\D/g, '');
  if (/^\d+$/.test(s) || (digits.length === s.replace(/[\s.+-]/g, '').length && digits.length >= 10)) {
    const d = digits.length >= 12 && digits.startsWith('55') ? digits.slice(2) : digits;
    if (d.length === 11) return true; // CPF
    if (d.length >= 10 && d.length <= 11) return true; // telefone BR
    return false;
  }

  if (s.includes('@')) {
    return Boolean(sanitizeContactEmail(s));
  }

  // Rejeita qualquer termo alfanumérico ambíguo (ex.: "55n encontrado")
  if (/[a-zA-Z]/.test(s)) return false;
  return digits.length >= 10;
}
