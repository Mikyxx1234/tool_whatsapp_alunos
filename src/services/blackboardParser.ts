import * as XLSX from 'xlsx';
import { normalizeBrazilianPhone } from '../utils/phoneNormalizer';
import { normalizeRgmCanonical } from '../utils/rgmNormalize';

/**
 * Parser do XLSX exportado pelo Blackboard.
 *
 * Colunas esperadas (case-insensitive, alguns sinônimos aceitos):
 *   Ciclo | RGM | Aluno | Email | Celular | Curso | Empresa |
 *   Instituição | Polo | Tipo matricula | Ultimo Acesso | Interações |
 *   Minutos | Total Registros
 *
 * Faz a conversão de "Ultimo Acesso" no formato serial Excel para Date.
 */

export interface BlackboardRow {
  ciclo: string | null;
  rgm: string | null;
  nome: string;
  email: string | null;
  telefone: string | null;
  telefoneNormalizado: string | null;
  curso: string | null;
  empresa: string | null;
  instituicao: string | null;
  polo: string | null;
  tipo_matricula: string | null;
  ultimo_acesso_blackboard: string | null;
  minutos_acesso: number | null;
  total_interacoes: number | null;
  total_registros: number | null;
  errors: string[];
  raw: Record<string, unknown>;
}

export interface BlackboardParseResult {
  rows: BlackboardRow[];
  totalRows: number;
  // contagem de linhas com cada problema, pra exibir no resumo
  invalidPhones: number;
  missingNames: number;
  missingRgmAndEmail: number;
}

function normalizeKey(key: string): string {
  return String(key || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .trim();
}

const COLUMN_ALIASES: Record<string, string[]> = {
  ciclo: ['ciclo'],
  rgm: ['rgm', 'matricula'],
  nome: ['aluno', 'nome', 'student'],
  email: ['email', 'e-mail'],
  telefone: ['celular', 'telefone', 'phone', 'whatsapp'],
  curso: ['curso', 'course'],
  empresa: ['empresa'],
  instituicao: ['instituicao', 'instituicao', 'institution'],
  polo: ['polo', 'unidade', 'campus'],
  tipo_matricula: ['tipo matricula', 'tipo_matricula', 'tipomatricula'],
  ultimo_acesso: ['ultimo acesso', 'ultimo_acesso', 'last_access', 'lastaccess'],
  interacoes: ['interacoes', 'interacoes', 'interactions'],
  minutos: ['minutos', 'minutes'],
  total_registros: ['total registros', 'total_registros', 'records'],
};

function detectColumns(sample: Record<string, unknown>): Record<string, string> {
  const keys = Object.keys(sample);
  const map: Record<string, string> = {};
  for (const role of Object.keys(COLUMN_ALIASES)) {
    const aliases = COLUMN_ALIASES[role];
    for (const k of keys) {
      if (aliases.includes(normalizeKey(k))) {
        map[role] = k;
        break;
      }
    }
  }
  return map;
}

/**
 * Excel armazena datas como número-serial dias-desde-1899-12-30 (com bug).
 * Aceita também strings ISO/Date direto.
 */
function parseExcelDate(value: unknown): string | null {
  if (value === null || value === undefined || value === '') return null;
  if (value instanceof Date && !Number.isNaN(value.getTime())) {
    // 1900-01-01 quase certamente é "nunca acessou"
    if (value.getUTCFullYear() < 1950) return null;
    return value.toISOString();
  }
  if (typeof value === 'number' || /^-?\d+(\.\d+)?$/.test(String(value))) {
    const serial = Number(value);
    if (!Number.isFinite(serial) || serial < 1) return null;
    // ms desde epoch UNIX
    const ms = (serial - 25569) * 86400 * 1000;
    const d = new Date(ms);
    if (Number.isNaN(d.getTime())) return null;
    if (d.getUTCFullYear() < 1950) return null;
    return d.toISOString();
  }
  const s = String(value).trim();
  if (!s) return null;
  // tenta ISO ou DD/MM/YYYY
  const iso = s.match(/^\d{4}-\d{2}-\d{2}/);
  if (iso) {
    const d = new Date(s);
    return Number.isNaN(d.getTime()) ? null : d.toISOString();
  }
  const br = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})/);
  if (br) {
    const [, dd, mm, yyyy] = br;
    const d = new Date(
      `${yyyy}-${mm.padStart(2, '0')}-${dd.padStart(2, '0')}T00:00:00Z`
    );
    return Number.isNaN(d.getTime()) ? null : d.toISOString();
  }
  return null;
}

function toIntOrNull(value: unknown): number | null {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? Math.trunc(n) : null;
}

function readArrayBuffer(file: File): Promise<ArrayBuffer> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as ArrayBuffer);
    reader.onerror = () => reject(reader.error || new Error('Falha ao ler arquivo'));
    reader.readAsArrayBuffer(file);
  });
}

export async function parseBlackboardFile(file: File): Promise<BlackboardParseResult> {
  const buffer = await readArrayBuffer(file);
  const wb = XLSX.read(buffer, { cellDates: true, type: 'array' });
  const sheet = wb.Sheets[wb.SheetNames[0]];
  if (!sheet) {
    return { rows: [], totalRows: 0, invalidPhones: 0, missingNames: 0, missingRgmAndEmail: 0 };
  }
  const json = XLSX.utils.sheet_to_json<Record<string, unknown>>(sheet, {
    defval: null,
    raw: true,
  });

  if (json.length === 0) {
    return { rows: [], totalRows: 0, invalidPhones: 0, missingNames: 0, missingRgmAndEmail: 0 };
  }

  const colMap = detectColumns(json[0]);
  const rows: BlackboardRow[] = [];
  let invalidPhones = 0;
  let missingNames = 0;
  let missingRgmAndEmail = 0;

  for (const r of json) {
    const get = (role: string): unknown => {
      const k = colMap[role];
      return k ? r[k] : null;
    };
    const nome = String(get('nome') || '').trim();
    const rgmRaw = String(get('rgm') || '').trim();
    const rgm = normalizeRgmCanonical(rgmRaw) || rgmRaw || '';
    const email = String(get('email') || '').trim().toLowerCase();
    const celularRaw = String(get('telefone') || '').trim();
    const norm = celularRaw ? normalizeBrazilianPhone(celularRaw) : { ok: false, phone: '' };

    const errors: string[] = [];
    if (!nome) {
      errors.push('nome obrigatório');
      missingNames += 1;
    }
    if (!rgm && !email) {
      errors.push('precisa ter pelo menos rgm ou email');
      missingRgmAndEmail += 1;
    }
    if (celularRaw && !norm.ok) {
      errors.push(`telefone inválido (${(norm as { reason?: string }).reason || ''})`);
      invalidPhones += 1;
    }

    rows.push({
      ciclo: (get('ciclo') as string) || null,
      rgm: rgm || null,
      nome,
      email: email || null,
      telefone: celularRaw || null,
      telefoneNormalizado: norm.ok ? norm.phone : null,
      curso: (get('curso') as string) || null,
      empresa: (get('empresa') as string) || null,
      instituicao: (get('instituicao') as string) || null,
      polo: (get('polo') as string) || null,
      tipo_matricula: (get('tipo_matricula') as string) || null,
      ultimo_acesso_blackboard: parseExcelDate(get('ultimo_acesso')),
      minutos_acesso: toIntOrNull(get('minutos')),
      total_interacoes: toIntOrNull(get('interacoes')),
      total_registros: toIntOrNull(get('total_registros')),
      errors,
      raw: r,
    });
  }

  return {
    rows,
    totalRows: rows.length,
    invalidPhones,
    missingNames,
    missingRgmAndEmail,
  };
}
