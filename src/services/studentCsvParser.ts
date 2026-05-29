import Papa from 'papaparse';
import { normalizeBrazilianPhone } from '../utils/phoneNormalizer';
import { fileToCsvText } from '../utils/fileToCsvText';

export interface StudentImportRow {
  nome: string;
  telefone: string;
  telefoneNormalizado: string;
  email: string;
  cpf: string;
  curso: string;
  polo: string;
  dataMatricula: string;
  dataInicio: string;
  dataAcessoLiberado: string;
  ultimoAcesso: string;
  gapDias: number | null;
  fluxo: 'A' | 'B' | 'C' | null;
  errors: string[];
  raw: Record<string, string>;
}

export interface StudentParseResult {
  rows: StudentImportRow[];
  totalRows: number;
}

const FIELD_KEYWORDS: Record<string, string[]> = {
  nome: ['nome', 'name', 'aluno', 'student'],
  telefone: ['telefone', 'phone', 'celular', 'whatsapp', 'numero', 'tel'],
  email: ['email', 'e-mail', 'mail'],
  cpf: ['cpf'],
  curso: ['curso', 'course'],
  polo: ['polo', 'unidade', 'campus'],
  data_matricula: ['data_matricula', 'matricula', 'dt_matricula', 'data matricula'],
  data_inicio_conteudo: [
    'data_inicio_conteudo',
    'data_inicio',
    'inicio_conteudo',
    'inicio',
    'dt_inicio',
    'data inicio',
  ],
  data_acesso_liberado: [
    'data_acesso_liberado',
    'acesso_liberado',
    'liberacao',
    'data_acesso',
  ],
  ultimo_acesso: ['ultimo_acesso', 'ultimo acesso', 'last_access', 'lastaccess'],
};

function normalizeKey(key: string): string {
  return String(key || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .trim();
}

function detectColumnRoles(headers: string[]): Record<number, string> {
  const map: Record<number, string> = {};
  for (let i = 0; i < headers.length; i += 1) {
    const norm = normalizeKey(headers[i]);
    for (const [role, keywords] of Object.entries(FIELD_KEYWORDS)) {
      if (keywords.includes(norm)) {
        map[i] = role;
        break;
      }
    }
  }
  return map;
}

function parseFlexibleDate(value: string): { iso: string; date: Date | null } {
  if (!value) return { iso: '', date: null };
  const v = value.trim();

  // ISO
  if (/^\d{4}-\d{2}-\d{2}/.test(v)) {
    const d = new Date(v);
    return Number.isNaN(d.getTime())
      ? { iso: '', date: null }
      : { iso: v.slice(0, 10), date: d };
  }
  // DD/MM/YYYY
  let m = v.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})/);
  if (m) {
    const [, dd, mm, yyyy] = m;
    const d = new Date(
      `${yyyy}-${mm.padStart(2, '0')}-${dd.padStart(2, '0')}T00:00:00Z`
    );
    if (Number.isNaN(d.getTime())) return { iso: '', date: null };
    return { iso: d.toISOString().slice(0, 10), date: d };
  }
  // DD-MM-YYYY
  m = v.match(/^(\d{1,2})-(\d{1,2})-(\d{4})/);
  if (m) {
    const [, dd, mm, yyyy] = m;
    const d = new Date(
      `${yyyy}-${mm.padStart(2, '0')}-${dd.padStart(2, '0')}T00:00:00Z`
    );
    return { iso: d.toISOString().slice(0, 10), date: d };
  }
  const fallback = new Date(v);
  if (Number.isNaN(fallback.getTime())) return { iso: '', date: null };
  return { iso: fallback.toISOString().slice(0, 10), date: fallback };
}

function diffDays(a: Date | null, b: Date | null): number | null {
  if (!a || !b) return null;
  const MS_PER_DAY = 86400000;
  return Math.round((b.getTime() - a.getTime()) / MS_PER_DAY);
}

function classify(gapDias: number | null): 'A' | 'B' | 'C' | null {
  if (gapDias === null) return null;
  if (gapDias <= 2) return 'A';
  if (gapDias <= 30) return 'B';
  return 'C';
}

export async function parseStudentsCsv(file: File): Promise<StudentParseResult> {
  const text = await fileToCsvText(file);
  if (!text.trim()) return { rows: [], totalRows: 0 };

  const result = Papa.parse<string[]>(text, {
    header: false,
    skipEmptyLines: 'greedy',
    delimiter: '',
    dynamicTyping: false,
  });

  const allRows: string[][] = (result.data || [])
    .filter((r) => Array.isArray(r) && r.some((c) => String(c ?? '').trim() !== ''))
    .map((r) => r.map((c) => String(c ?? '').trim()));

  if (allRows.length === 0) return { rows: [], totalRows: 0 };

  const header = allRows[0];
  const roles = detectColumnRoles(header);
  const dataRows = Object.keys(roles).length > 0 ? allRows.slice(1) : allRows;

  // Se nenhum cabeçalho identificável, falhamos com erro de coluna inválida
  if (Object.keys(roles).length === 0) {
    return {
      rows: dataRows.map((row) => ({
        nome: row[0] || '',
        telefone: row[1] || '',
        telefoneNormalizado: '',
        email: '',
        cpf: '',
        curso: '',
        polo: '',
        dataMatricula: '',
        dataInicio: '',
        dataAcessoLiberado: '',
        ultimoAcesso: '',
        gapDias: null,
        fluxo: null,
        errors: ['CSV sem cabeçalho reconhecido. Cabeçalhos esperados: nome, telefone, email, cpf, curso, polo, data_matricula, data_inicio_conteudo.'],
        raw: row.reduce<Record<string, string>>((acc, val, idx) => {
          acc[`col_${idx + 1}`] = val;
          return acc;
        }, {}),
      })),
      totalRows: dataRows.length,
    };
  }

  const rows: StudentImportRow[] = [];

  for (const row of dataRows) {
    const get = (role: string): string => {
      const idx = Object.entries(roles).find(([, r]) => r === role)?.[0];
      return idx !== undefined ? row[Number(idx)] || '' : '';
    };

    const nome = get('nome');
    const telefoneRaw = get('telefone');
    const email = get('email');
    const cpf = get('cpf').replace(/\D+/g, '');
    const curso = get('curso');
    const polo = get('polo');
    const dataMatriculaRaw = get('data_matricula');
    const dataInicioRaw = get('data_inicio_conteudo');
    const dataAcessoLiberado = get('data_acesso_liberado');
    const ultimoAcesso = get('ultimo_acesso');

    const norm = normalizeBrazilianPhone(telefoneRaw);
    const dm = parseFlexibleDate(dataMatriculaRaw);
    const di = parseFlexibleDate(dataInicioRaw);
    const dal = parseFlexibleDate(dataAcessoLiberado);
    const ua = parseFlexibleDate(ultimoAcesso);
    const gap = diffDays(dm.date, di.date);
    const fluxo = classify(gap);

    const errors: string[] = [];
    if (!nome) errors.push('nome obrigatório');
    if (!norm.ok && telefoneRaw) errors.push(`telefone inválido (${norm.reason})`);
    if (!norm.ok && !telefoneRaw && !cpf) errors.push('telefone ou cpf obrigatório');
    if (dataMatriculaRaw && !dm.iso) errors.push('data_matricula inválida');
    if (dataInicioRaw && !di.iso) errors.push('data_inicio_conteudo inválida');

    const raw: Record<string, string> = {};
    Object.entries(roles).forEach(([idx, role]) => {
      raw[role] = row[Number(idx)] || '';
    });

    rows.push({
      nome,
      telefone: telefoneRaw,
      telefoneNormalizado: norm.ok ? norm.phone : '',
      email,
      cpf,
      curso,
      polo,
      dataMatricula: dm.iso,
      dataInicio: di.iso,
      dataAcessoLiberado: dal.iso,
      ultimoAcesso: ua.iso,
      gapDias: gap,
      fluxo,
      errors,
      raw,
    });
  }

  return { rows, totalRows: dataRows.length };
}
