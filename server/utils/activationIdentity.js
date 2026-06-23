import { normalizeRgmCanonical } from './rgmDisplay.js';

/**
 * Chave mestra para deduplicar ativação: mesma pessoa não ativa 2x na MESMA categoria.
 * Ordem: RGM → CPF → telefone → e-mail.
 */

function digits(v) {
  return String(v ?? '')
    .replace(/\D/g, '')
    .trim();
}

function normalizeEmail(v) {
  const s = String(v ?? '').trim().toLowerCase();
  if (s.length < 6 || !s.includes('@')) return '';
  const [, domain] = s.split('@');
  return domain && domain.includes('.') ? s : '';
}

function normalizePhone(v) {
  let d = digits(v);
  if (d.length >= 12 && d.startsWith('55')) d = d.slice(2);
  return d.length >= 10 && d.length <= 11 ? d : '';
}

/**
 * @param {{ rgm?: string, cpf?: string, email?: string, telefone?: string }} parts
 */
export function masterKeyFromParts(parts) {
  const rgm = normalizeRgmCanonical(parts.rgm);
  if (rgm) return `RGM:${rgm}`;
  const cpfD = digits(parts.cpf);
  if (cpfD.length === 11) return `CPF:${cpfD}`;
  const tel = normalizePhone(parts.telefone);
  if (tel) return `TEL:${tel}`;
  const email = normalizeEmail(parts.email);
  if (email) return `EMAIL:${email}`;
  return null;
}

/**
 * @param {Record<string, unknown>} row
 */
export function masterKeyFromRow(row) {
  return masterKeyFromParts({
    rgm: row.RGM ?? row.Rgm ?? row.Matricula ?? row.matricula,
    cpf: row.CPF ?? row.Cpf,
    email: row.Email ?? row['E-mail'],
    telefone: row['Fone celular'] ?? row.Celular ?? row.Telefone,
  });
}

/**
 * @param {{ rgm?: string, cpf?: string, email?: string, telefone?: string }} item
 */
export function masterKeyFromActivationItem(item) {
  return masterKeyFromParts(item);
}

/**
 * Todas as chaves possíveis para achar histórico de disparo (RGM, CPF, tel, e-mail).
 * @param {{ rgm?: string, cpf?: string, email?: string, telefone?: string, phone?: string }} parts
 * @returns {string[]}
 */
export function lookupMasterKeysFromParts(parts) {
  const keys = new Set();
  const primary = masterKeyFromParts({
    rgm: parts.rgm,
    cpf: parts.cpf,
    email: parts.email,
    telefone: parts.telefone ?? parts.phone,
  });
  if (primary) keys.add(primary);
  const cpfD = digits(parts.cpf);
  if (cpfD.length === 11) keys.add(`CPF:${cpfD}`);
  const tel = normalizePhone(parts.telefone ?? parts.phone);
  if (tel) keys.add(`TEL:${tel}`);
  const email = normalizeEmail(parts.email);
  if (email) keys.add(`EMAIL:${email}`);
  const rgm = normalizeRgmCanonical(parts.rgm);
  if (rgm) keys.add(`RGM:${rgm}`);
  return [...keys];
}
