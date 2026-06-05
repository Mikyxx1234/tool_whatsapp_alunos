import { apiAuthHeaders } from './apiAuth';

/** Categorias aceitas no backend (espelha VALID_MEU_PAINEL_CATEGORIES). */
export const MEU_PAINEL_CATEGORIES = [
  'docs-pendentes',
  'financeiro',
  'acessos-blackboard',
  'processos-caa',
  'provavel-evasao',
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

/** Apenas para admin: atribui consultor_responsavel_nome a uma resposta. */
export async function assignConsultorToResponse(
  responseId: string,
  consultorNome: string | null,
  role: string
) {
  return jsonFetch<{ ok: true; row: MeuPainelItem }>(
    `/api/activation/responses/${encodeURIComponent(responseId)}/assign-consultor`,
    {
      method: 'PATCH',
      body: JSON.stringify({ consultor_nome: consultorNome, role }),
    }
  );
}

export async function fetchConsultoresDistintos() {
  return jsonFetch<{ consultores: string[] }>('/api/activation/consultores-distintos');
}

/** Lê identidade do consultor passada via query param pelo dcz-crm-sync.
 *  Persistência: na primeira carga, se a URL traz os params, salva em localStorage.
 *  Em navegações internas (react-router não preserva ?query) cai pro localStorage.
 *  Limpa quando role/identidade muda — qualquer query nova sobrescreve.
 */
const LS_KEY = 'dw_consultor_identity_v1';

interface ConsultorIdentity {
  username: string | null;
  nome: string | null;
  role: string | null;
}

export function readConsultorIdentity(): ConsultorIdentity {
  if (typeof window === 'undefined') return { username: null, nome: null, role: null };
  const qs = new URLSearchParams(window.location.search);
  const fromQs: ConsultorIdentity = {
    username: qs.get('consultor') || null,
    nome: qs.get('consultor_nome') || null,
    role: qs.get('role') || null,
  };
  const hasFromQs = Boolean(fromQs.username || fromQs.nome || fromQs.role);
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
      };
    }
  } catch { /* noop */ }
  return { username: null, nome: null, role: null };
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
};
