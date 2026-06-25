import { apiAuthHeaders } from './apiAuth';

/** Categorias aceitas no backend (espelha VALID_MEU_PAINEL_CATEGORIES). */
export const MEU_PAINEL_CATEGORIES = [
  'docs-pendentes',
  'financeiro',
  'acessos-blackboard',
  'processos-caa',
  'provavel-evasao',
  'rematricula',
] as const;

export type MeuPainelCategory = (typeof MEU_PAINEL_CATEGORIES)[number];

export type OutcomeKind = 'revertido' | 'confirmado' | 'sem_contato' | 'outro';

export interface MeuPainelStats {
  total_atribuido: number;
  total_opt_out: number;
  total_marcado: number;
  total_revertido: number;
  total_confirmado: number;
  total_sem_contato: number;
  total_outro: number;
  taxa_reversao: number;
}

export interface MeuPainelItem {
  response_id: string;
  category: string;
  master_key: string | null;
  rgm: string | null;
  telefone: string | null;
  consultor_responsavel_nome: string | null;
  origem_ativacao: string | null;
  response_kind: string;
  message_text: string | null;
  button_payload: string | null;
  received_at: string;
  protocolo: string | null;
  nome: string | null;
  cpf: string | null;
  curso: string | null;
  polo: string | null;
  caa_status: string | null;
  caa_last_change_at: string | null;
  outcome_id: string | null;
  outcome: OutcomeKind | null;
  outcome_motivo: string | null;
  outcome_notes: string | null;
  outcome_occurred_at: string | null;
  outcome_consultor_nome: string | null;
  outcome_has_proof: boolean | null;
  is_manual?: boolean;
}

export interface MeuPainelListResponse {
  consultor: string | null;
  is_admin: boolean;
  total: number;
  items: MeuPainelItem[];
  missing_consultor?: boolean;
}

export interface MeuPainelStatsResponse {
  consultor: string | null;
  is_admin: boolean;
  missing_consultor?: boolean;
  stats: MeuPainelStats;
}

export interface MeuPainelFilters {
  consultor?: string | null;
  role?: string | null;
  /** Categoria do dcz (ex: "Supervisor Acadêmico"). Backend libera "ver tudo"
   *  pra essa categoria igual ao role=admin. */
  categoria?: string | null;
  category?: MeuPainelCategory | null;
  from?: string | null;
  to?: string | null;
  limit?: number;
  offset?: number;
}

async function jsonFetch<T>(input: string, init?: RequestInit): Promise<T> {
  const response = await fetch(input, {
    ...init,
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/json',
      ...apiAuthHeaders(),
      ...(init?.headers || {}),
    },
  });
  const text = await response.text();
  let data: unknown = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = { raw: text };
  }
  if (!response.ok) {
    const payload = data as { error?: string };
    throw new Error(payload?.error || `Requisicao falhou (${response.status})`);
  }
  return data as T;
}

function buildQuery(filters: MeuPainelFilters): string {
  const params = new URLSearchParams();
  if (filters.consultor) params.set('consultor', filters.consultor);
  if (filters.role) params.set('role', filters.role);
  if (filters.categoria) params.set('categoria', filters.categoria);
  if (filters.category) params.set('category', filters.category);
  if (filters.from) params.set('from', filters.from);
  if (filters.to) params.set('to', filters.to);
  if (filters.limit != null) params.set('limit', String(filters.limit));
  if (filters.offset != null) params.set('offset', String(filters.offset));
  const qs = params.toString();
  return qs ? `?${qs}` : '';
}

export async function fetchMeuPainelList(filters: MeuPainelFilters = {}) {
  return jsonFetch<MeuPainelListResponse>(`/api/activation/meu-painel/list${buildQuery(filters)}`);
}

export async function fetchMeuPainelStats(filters: MeuPainelFilters = {}) {
  return jsonFetch<MeuPainelStatsResponse>(`/api/activation/meu-painel/stats${buildQuery(filters)}`);
}

export interface CreateOutcomePayload {
  category: MeuPainelCategory | string;
  rgm?: string | null;
  cpf?: string | null;
  nome?: string | null;
  protocolo?: string | null;
  master_key?: string | null;
  outcome: OutcomeKind;
  motivo?: string | null;
  notes?: string | null;
  consultor_nome: string;
  occurred_at?: string | null;
}

export async function createOutcome(payload: CreateOutcomePayload) {
  return jsonFetch<{ ok: true; outcome: unknown }>('/api/activation/meu-painel/outcomes', {
    method: 'POST',
    body: JSON.stringify(payload),
  });
}

export interface CreateManualLeadPayload {
  category?: MeuPainelCategory | 'processos-caa';
  /** caa = relatório (protocolo obrigatório); caa_atm e caa_ia = conversa, sem protocolo */
  origem_ativacao?: 'caa' | 'caa_atm' | 'caa_ia';
  protocolo?: string | null;
  rgm: string;
  nome?: string | null;
  cpf?: string | null;
  telefone?: string | null;
  curso?: string | null;
  polo?: string | null;
  consultor_nome: string;
}

export async function createManualLead(payload: CreateManualLeadPayload) {
  return jsonFetch<{ ok: true; row: MeuPainelItem }>('/api/activation/meu-painel/leads', {
    method: 'POST',
    body: JSON.stringify(payload),
  });
}

export async function deleteManualLead(responseId: string) {
  return jsonFetch<{ ok: true; deleted_id: string }>(
    `/api/activation/meu-painel/leads/${encodeURIComponent(responseId)}`,
    { method: 'DELETE' }
  );
}

/** Admin ou Supervisor Acadêmico: atribui consultor_responsavel_nome a uma resposta. */
export async function assignConsultorToResponse(
  responseId: string,
  consultorNome: string | null,
  role: string,
  categoria?: string | null
) {
  return jsonFetch<{ ok: true; row: MeuPainelItem }>(
    `/api/activation/responses/${encodeURIComponent(responseId)}/assign-consultor`,
    {
      method: 'PATCH',
      body: JSON.stringify({ consultor_nome: consultorNome, role, categoria: categoria || null }),
    }
  );
}

export async function fetchConsultoresDistintos() {
  return jsonFetch<{ consultores: string[] }>('/api/activation/consultores-distintos');
}

/** Le ?consultores=A|B|C da URL (injetado pelo dcz-crm-sync APENAS para admin)
 *  e persiste em localStorage pra sobreviver a navegacao client-side.
 *  Chamada uma vez no boot do app, em main.tsx. */
export function readConsultoresAcademicosFromUrl(): string[] {
  if (typeof window === 'undefined') return [];
  try {
    const qs = new URLSearchParams(window.location.search);
    const raw = qs.get('consultores');
    if (raw) {
      const list = raw
        .split('|')
        .map((s) => s.trim())
        .filter(Boolean);
      try { localStorage.setItem(LS_CONSULTORES_KEY, JSON.stringify(list)); } catch { /* noop */ }
      return list;
    }
  } catch { /* noop */ }
  return getConsultoresAcademicos();
}

/** Le do localStorage a lista persistida em readConsultoresAcademicosFromUrl. */
export function getConsultoresAcademicos(): string[] {
  if (typeof window === 'undefined') return [];
  try {
    const raw = localStorage.getItem(LS_CONSULTORES_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) return parsed.filter((x) => typeof x === 'string');
    }
  } catch { /* noop */ }
  return [];
}

/* ============================================================================
   Abas permitidas — filtragem de paginas para nao-admin
   ----------------------------------------------------------------------------
   O dcz-crm-sync passa &abas_permitidas=disparador|alunos|... na URL do
   iframe APENAS quando o usuario nao-admin tem sub-permissoes setadas.
   Sem o param (admin, ou usuario sem sub-permissoes especificas, ou app
   aberto fora do iframe), TUDO e permitido (compat).
   ========================================================================== */

export type AbaSlug =
  | 'disparador'
  | 'alunos'
  | 'calendario'
  | 'bases'
  | 'relatorios'
  | 'conversao'
  | 'meu_painel'
  | 'regras';

export const ABA_SLUGS_VALIDOS: AbaSlug[] = [
  'disparador', 'alunos', 'calendario', 'bases',
  'relatorios', 'conversao', 'meu_painel', 'regras',
];

/** Le ?abas_permitidas=a|b|c da URL e persiste em localStorage.
 *  null = sem restricao (admin ou compat). [] = bloqueia tudo. */
export function readAbasPermitidasFromUrl(): AbaSlug[] | null {
  if (typeof window === 'undefined') return null;
  try {
    const qs = new URLSearchParams(window.location.search);
    if (qs.has('abas_permitidas')) {
      const raw = qs.get('abas_permitidas') || '';
      const list = raw
        .split('|')
        .map((s) => s.trim().toLowerCase())
        .filter((s): s is AbaSlug => (ABA_SLUGS_VALIDOS as string[]).includes(s));
      try {
        localStorage.setItem(LS_ABAS_PERMITIDAS_KEY, JSON.stringify(list));
      } catch { /* noop */ }
      return list;
    }
    // Quando a URL nao traz o param na primeira carga, removemos eventual
    // restricao antiga (admin pode ter logado depois de um nao-admin).
    try { localStorage.removeItem(LS_ABAS_PERMITIDAS_KEY); } catch { /* noop */ }
  } catch { /* noop */ }
  return null;
}

/** Le do localStorage. null = sem restricao. */
export function getAbasPermitidas(): AbaSlug[] | null {
  if (typeof window === 'undefined') return null;
  try {
    const raw = localStorage.getItem(LS_ABAS_PERMITIDAS_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) {
        return parsed.filter((x): x is AbaSlug => (ABA_SLUGS_VALIDOS as string[]).includes(x));
      }
    }
  } catch { /* noop */ }
  return null;
}

export function isAbaPermitida(slug: AbaSlug): boolean {
  const allowed = getAbasPermitidas();
  if (allowed === null) return true;
  return allowed.includes(slug);
}

/** Mapping rota react-router -> slug da aba. Usado pelo App.tsx pra
 *  redirecionar quando o usuario tenta acessar uma rota negada. */
export const ROUTE_TO_ABA: Array<{ path: string; slug: AbaSlug; match: (p: string) => boolean }> = [
  { path: '/',              slug: 'disparador',  match: (p) => p === '/' },
  { path: '/students',      slug: 'alunos',      match: (p) => p === '/students' || p.startsWith('/students/') },
  { path: '/academic-terms',slug: 'calendario',  match: (p) => p.startsWith('/academic-terms') },
  { path: '/bases',         slug: 'bases',       match: (p) => p.startsWith('/bases') },
  { path: '/reports',       slug: 'relatorios',  match: (p) => p.startsWith('/reports') },
  { path: '/conversao',     slug: 'conversao',   match: (p) => p.startsWith('/conversao') },
  { path: '/meu-painel',    slug: 'meu_painel',  match: (p) => p.startsWith('/meu-painel') },
  { path: '/journey-rules', slug: 'regras',      match: (p) => p.startsWith('/journey-rules') },
];

/** Primeira rota permitida ao usuario (pra fallback em "/" quando o
 *  usuario nao tem `disparador` permitido). */
export function firstAllowedRoute(): string {
  const allowed = getAbasPermitidas();
  if (allowed === null || allowed.length === 0) return '/';
  for (const r of ROUTE_TO_ABA) {
    if (allowed.includes(r.slug)) return r.path;
  }
  return '/';
}

/** Lê identidade do consultor passada via query param pelo dcz-crm-sync.
 *  Persistência: na primeira carga, se a URL traz os params, salva em localStorage.
 *  Em navegações internas (react-router não preserva ?query) cai pro localStorage.
 *  Limpa quando role/identidade muda — qualquer query nova sobrescreve.
 */
const LS_KEY = 'dw_consultor_identity_v1';
const LS_CONSULTORES_KEY = 'dw_consultores_academicos_admin_v1';
const LS_ABAS_PERMITIDAS_KEY = 'dw_abas_permitidas_v1';

interface ConsultorIdentity {
  username: string | null;
  nome: string | null;
  role: string | null;
  categoria: string | null;
}

/** True se a categoria (case/accent-insensitive) é "Supervisor Acadêmico". */
export function isSupervisorAcademico(categoria: string | null | undefined): boolean {
  if (!categoria) return false;
  const norm = categoria.normalize('NFD').replace(/[\u0300-\u036f]/g, '').trim().toLowerCase();
  return norm === 'supervisor academico';
}

/** True se o usuário tem poder pleno no Meu Painel (admin OU Supervisor Acadêmico). */
export function hasFullAccess(identity: ConsultorIdentity): boolean {
  return identity.role === 'admin' || isSupervisorAcademico(identity.categoria);
}

export function readConsultorIdentity(): ConsultorIdentity {
  const empty: ConsultorIdentity = { username: null, nome: null, role: null, categoria: null };
  if (typeof window === 'undefined') return empty;
  const qs = new URLSearchParams(window.location.search);
  const fromQs: ConsultorIdentity = {
    username: qs.get('consultor') || null,
    nome: qs.get('consultor_nome') || null,
    role: qs.get('role') || null,
    categoria: qs.get('categoria') || null,
  };
  const hasFromQs = Boolean(fromQs.username || fromQs.nome || fromQs.role || fromQs.categoria);
  if (hasFromQs) {
    try { localStorage.setItem(LS_KEY, JSON.stringify(fromQs)); } catch { /* noop */ }
    return fromQs;
  }
  try {
    const raw = localStorage.getItem(LS_KEY);
    if (raw) {
      const stored = JSON.parse(raw) as ConsultorIdentity;
      return {
        username: stored?.username ?? null,
        nome: stored?.nome ?? null,
        role: stored?.role ?? null,
        categoria: stored?.categoria ?? null,
      };
    }
  } catch { /* noop */ }
  return empty;
}

/** Rótulos humanos. */
export const OUTCOME_LABEL: Record<OutcomeKind, string> = {
  revertido: 'Revertido (deferiu)',
  confirmado: 'Confirmado (saiu)',
  sem_contato: 'Sem contato',
  outro: 'Outro',
};

export const OUTCOME_SHORT_LABEL: Record<OutcomeKind, string> = {
  revertido: 'Revertido',
  confirmado: 'Confirmado',
  sem_contato: 'Sem contato',
  outro: 'Outro',
};

/** Tom visual por outcome — bate com paletas dark mode. */
export const OUTCOME_TONE: Record<OutcomeKind, string> = {
  revertido: 'bg-emerald-50 text-emerald-800 border-emerald-200',
  confirmado: 'bg-rose-50 text-rose-800 border-rose-200',
  sem_contato: 'bg-amber-50 text-amber-800 border-amber-200',
  outro: 'bg-slate-50 text-slate-800 border-slate-200',
};

export const CATEGORY_LABEL: Record<string, string> = {
  'docs-pendentes': 'Docs Pendentes',
  'financeiro': 'Financeiro',
  'acessos-blackboard': 'Acessos Blackboard',
  'processos-caa': 'Processos CAA',
  'provavel-evasao': 'Provável Evasão',
  rematricula: 'Rematrícula',
};

/** Rótulo da coluna BASE no Meu Painel; diferencia sub-origens de processos CAA. */
export function getMeuPainelBaseLabel(
  category: string,
  origemAtivacao?: string | null
): string {
  if (category === 'processos-caa') {
    const origem = (origemAtivacao || '').trim().toLowerCase();
    if (!origem) return 'processos Caa';
    if (origem === 'caa') return 'processos CAA';
    if (origem === 'caa_ia') return 'Processos CAA_IA';
    if (origem === 'caa_atm') return 'processos CAA_ATM';
  }
  return CATEGORY_LABEL[category] || category;
}
