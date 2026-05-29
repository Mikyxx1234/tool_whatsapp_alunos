import { apiAuthHeaders } from './apiAuth';
import { fetchJson } from './httpJson';
import type { ActivationCategory } from './activationApi';

export type OutcomeKind = 'revertido' | 'confirmado' | 'sem_contato' | 'outro';

export interface ManualOutcomeDTO {
  id: string;
  category: ActivationCategory;
  master_key: string | null;
  rgm: string | null;
  cpf: string | null;
  nome: string | null;
  protocolo: string | null;
  outcome: OutcomeKind;
  motivo: string | null;
  notes: string | null;
  has_proof: boolean;
  proof_mime: string | null;
  proof_size_bytes: number | null;
  consultor_nome: string;
  occurred_at: string;
  created_at: string;
}

export interface ManualOutcomeCreateInput {
  category: ActivationCategory;
  rgm?: string;
  cpf?: string;
  nome?: string;
  protocolo?: string;
  outcome: OutcomeKind;
  motivo?: string;
  notes?: string;
  consultor_nome: string;
  occurred_at?: string;
}

export interface ManualOutcomeFilters {
  category?: ActivationCategory;
  rgm?: string;
  outcome?: OutcomeKind;
  consultor?: string;
  from?: string;
  to?: string;
  search?: string;
  limit?: number;
  offset?: number;
}

export const manualOutcomesApi = {
  create(input: ManualOutcomeCreateInput) {
    return fetchJson<{ ok: boolean; outcome: ManualOutcomeDTO }>('/api/manual-outcomes', {
      method: 'POST',
      body: JSON.stringify(input),
    });
  },

  list(filters: ManualOutcomeFilters = {}) {
    const params = new URLSearchParams();
    if (filters.category) params.set('category', filters.category);
    if (filters.rgm) params.set('rgm', filters.rgm);
    if (filters.outcome) params.set('outcome', filters.outcome);
    if (filters.consultor) params.set('consultor', filters.consultor);
    if (filters.from) params.set('from', filters.from);
    if (filters.to) params.set('to', filters.to);
    if (filters.search) params.set('search', filters.search);
    if (filters.limit != null) params.set('limit', String(filters.limit));
    if (filters.offset != null) params.set('offset', String(filters.offset));
    const q = params.toString() ? `?${params}` : '';
    return fetchJson<{ items: ManualOutcomeDTO[] }>(`/api/manual-outcomes${q}`);
  },

  get(id: string) {
    return fetchJson<{ outcome: ManualOutcomeDTO }>(`/api/manual-outcomes/${id}`);
  },

  delete(id: string) {
    return fetchJson<{ ok: boolean }>(`/api/manual-outcomes/${id}`, { method: 'DELETE' });
  },

  async uploadProof(id: string, file: File): Promise<{ ok: boolean; outcome: ManualOutcomeDTO }> {
    const controller = new AbortController();
    const timer = window.setTimeout(() => controller.abort(), 60_000);
    try {
      const response = await fetch(`/api/manual-outcomes/${id}/proof`, {
        method: 'POST',
        signal: controller.signal,
        headers: {
          'Content-Type': file.type || 'application/octet-stream',
          'X-File-Name': encodeURIComponent(file.name),
          ...apiAuthHeaders(),
        },
        body: file,
      });
      const text = await response.text();
      let data: unknown = null;
      try {
        data = text ? JSON.parse(text) : null;
      } catch {
        data = { raw: text };
      }
      if (!response.ok) {
        const message = (data as { error?: string })?.error || `Upload falhou (${response.status})`;
        throw new Error(message);
      }
      return data as { ok: boolean; outcome: ManualOutcomeDTO };
    } finally {
      window.clearTimeout(timer);
    }
  },

  deleteProof(id: string) {
    return fetchJson<{ ok: boolean }>(`/api/manual-outcomes/${id}/proof`, { method: 'DELETE' });
  },

  proofUrl(id: string) {
    return `/api/manual-outcomes/${id}/proof`;
  },

  async fetchProofBlobUrl(id: string): Promise<string> {
    const response = await fetch(`/api/manual-outcomes/${id}/proof`, {
      headers: { ...apiAuthHeaders() },
    });
    if (!response.ok) throw new Error(`Falha ao carregar anexo (${response.status})`);
    const blob = await response.blob();
    return URL.createObjectURL(blob);
  },

  protocolsByRgm(rgm: string) {
    return fetchJson<{ protocols: string[] }>(`/api/manual-outcomes/protocols-by-rgm/${encodeURIComponent(rgm)}`);
  },
};
