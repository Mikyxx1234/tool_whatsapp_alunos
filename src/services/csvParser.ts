import Papa from 'papaparse';
import { v4 as uuid } from 'uuid';
import type { Contact } from '../types';
import { normalizeBrazilianPhone } from '../utils/phoneNormalizer';
import { fileToCsvText } from '../utils/fileToCsvText';

type FieldKind = 'phone' | 'name' | 'email' | 'course' | 'origin' | 'extra';

const FIELD_KEYWORDS: Record<Exclude<FieldKind, 'extra'>, string[]> = {
  phone: ['telefone', 'phone', 'celular', 'whatsapp', 'numero', 'número', 'tel', 'fone'],
  name: ['nome', 'name', 'cliente', 'aluno'],
  email: ['email', 'e-mail', 'mail'],
  course: ['curso', 'course'],
  origin: ['origem', 'origin', 'fonte', 'source'],
};

const ALL_KEYWORDS = new Set(
  Object.values(FIELD_KEYWORDS).flat().map(normalizeKey)
);

function normalizeKey(key: string): string {
  return String(key || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .trim();
}

function detectFieldKind(headerCell: string): FieldKind {
  const norm = normalizeKey(headerCell);
  for (const [kind, keywords] of Object.entries(FIELD_KEYWORDS) as [
    Exclude<FieldKind, 'extra'>,
    string[]
  ][]) {
    if (keywords.includes(norm)) return kind;
  }
  return 'extra';
}

function looksLikePhone(value: string): boolean {
  const digits = String(value || '').replace(/\D/g, '');
  return digits.length >= 8 && digits.length <= 15;
}

export interface ParseResult {
  contacts: Contact[];
  totalRows: number;
}

/**
 * Lê um arquivo CSV ou XLSX, normaliza os telefones e marca duplicados.
 *
 * Suporta:
 *  - CSV/XLSX com cabeçalho conhecido (telefone, nome, email, curso, origem...)
 *  - CSV/XLSX "cru" sem cabeçalho: assume coluna 0 = telefone, coluna 1 = nome
 *  - Lista de telefones um por linha (sem separador)
 */
export async function parseContactsCsv(file: File): Promise<ParseResult> {
  const text = await fileToCsvText(file);
  if (!text.trim()) {
    return { contacts: [], totalRows: 0 };
  }

  const result = Papa.parse<string[]>(text, {
    header: false,
    skipEmptyLines: 'greedy',
    delimiter: '',
    dynamicTyping: false,
  });

  const rows: string[][] = (result.data || [])
    .filter((r) => Array.isArray(r) && r.some((cell) => String(cell ?? '').trim() !== ''))
    .map((r) => r.map((cell) => String(cell ?? '').trim()));

  if (rows.length === 0) {
    return { contacts: [], totalRows: 0 };
  }

  const firstRow = rows[0];
  const hasHeader = firstRow.some((cell) => ALL_KEYWORDS.has(normalizeKey(cell)));

  let columnMap: FieldKind[];
  let headerLabels: string[];
  let dataRows: string[][];

  if (hasHeader) {
    columnMap = firstRow.map(detectFieldKind);
    headerLabels = firstRow.map((c) => normalizeKey(c) || `col_${c}`);
    dataRows = rows.slice(1);
  } else {
    // Sem cabeçalho: convencionamos col 0 = telefone, col 1 = nome, demais = extras
    columnMap = firstRow.map((_, idx) => {
      if (idx === 0) return 'phone';
      if (idx === 1) return 'name';
      return 'extra';
    });
    headerLabels = firstRow.map((_, idx) => `col_${idx + 1}`);
    dataRows = rows;
  }

  const seenPhones = new Set<string>();
  const contacts: Contact[] = [];

  for (const row of dataRows) {
    let rawPhone = '';
    let name: string | undefined;
    let email: string | undefined;
    let curso: string | undefined;
    let origem: string | undefined;
    const extras: Record<string, string> = {};

    for (let i = 0; i < row.length; i += 1) {
      const value = row[i];
      if (!value) continue;
      const kind = columnMap[i] ?? 'extra';
      switch (kind) {
        case 'phone':
          if (!rawPhone) rawPhone = value;
          break;
        case 'name':
          if (!name) name = value;
          break;
        case 'email':
          if (!email) email = value;
          break;
        case 'course':
          if (!curso) curso = value;
          break;
        case 'origin':
          if (!origem) origem = value;
          break;
        default: {
          const label = headerLabels[i] || `col_${i + 1}`;
          extras[label] = value;
        }
      }
    }

    // Fallback robusto: se não tem telefone identificado mas alguma célula parece telefone
    if (!rawPhone) {
      const candidate = row.find((cell) => looksLikePhone(cell));
      if (candidate) rawPhone = candidate;
    }

    const normalized = normalizeBrazilianPhone(rawPhone);

    let status: Contact['status'];
    let errorMessage: string | undefined;

    if (!normalized.ok) {
      status = 'invalid';
      errorMessage = normalized.reason || 'telefone inválido';
    } else if (seenPhones.has(normalized.phone)) {
      status = 'duplicate';
      errorMessage = 'telefone duplicado na base';
    } else {
      status = 'valid';
      seenPhones.add(normalized.phone);
    }

    contacts.push({
      id: uuid(),
      rawPhone: rawPhone || '',
      phone: normalized.phone,
      name,
      email,
      curso,
      origem,
      extras,
      status,
      errorMessage,
    });
  }

  return { contacts, totalRows: dataRows.length };
}

export function summarizeContacts(contacts: Contact[]) {
  return {
    total: contacts.length,
    valid: contacts.filter((c) => c.status === 'valid' || isInProgress(c.status)).length,
    invalid: contacts.filter((c) => c.status === 'invalid').length,
    duplicates: contacts.filter((c) => c.status === 'duplicate').length,
    sent: contacts.filter((c) => c.status === 'sent').length,
    errors: contacts.filter((c) => c.status === 'error').length,
  };
}

function isInProgress(status: Contact['status']): boolean {
  return status === 'pending' || status === 'sending' || status === 'sent' || status === 'error';
}
