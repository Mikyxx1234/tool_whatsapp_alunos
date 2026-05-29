async function jsonFetch<T>(input: string, init?: RequestInit): Promise<T> {
  const response = await fetch(input, {
    ...init,
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/json',
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
    const message =
      (data as { error?: string })?.error ||
      `Requisição falhou (${response.status})`;
    throw new Error(message);
  }
  return data as T;
}

export type ActivationCategory = 'docs-pendentes' | 'acessos-blackboard' | 'processos-caa';

export interface ActivationListItem {
  nome: string;
  email: string;
  telefone: string;
  rgm: string;
  cpf: string;
  polo: string;
  curso: string;
  ciclo: string;
  situacao_matricula: string;
}

export interface DatacrazyLeadSummary {
  id: string;
  name: string;
  email: string;
  phone: string;
  source: string;
  tags: string[];
}

export interface ActivationListResponse {
  category?: ActivationCategory;
  total: number;
  items: ActivationListItem[];
  generated_at: string;
}

export interface EnrichedActivationItem extends ActivationListItem {
  datacrazy_found: boolean;
  datacrazy: DatacrazyLeadSummary | null;
  datacrazy_error?: string;
}

export interface DatacrazyEnrichResponse {
  category?: ActivationCategory;
  total: number;
  offset: number;
  limit: number;
  processed: number;
  found: number;
  not_found: number;
  errors: number;
  results: EnrichedActivationItem[];
  has_more: boolean;
  next_offset: number;
  mode?: string;
  datacrazy_pages?: number;
  datacrazy_leads_scanned?: number;
  datacrazy_early_stop?: boolean;
}

export const activationApi = {
  list(category: ActivationCategory) {
    return jsonFetch<ActivationListResponse>(`/api/activation/${category}/list`);
  },

  datacrazyEnrich(category: ActivationCategory, opts?: { offset?: number; limit?: number }) {
    return jsonFetch<DatacrazyEnrichResponse>(`/api/activation/${category}/datacrazy`, {
      method: 'POST',
      body: JSON.stringify({ offset: opts?.offset ?? 0, limit: opts?.limit ?? 0 }),
    });
  },

  exportCsvUrl(category: ActivationCategory) {
    return `/api/activation/${category}/export.csv`;
  },

  /** @deprecated use datacrazyEnrich('docs-pendentes') */
  docsPendentesDatacrazyEnrich(opts?: { offset?: number; limit?: number }) {
    return this.datacrazyEnrich('docs-pendentes', opts);
  },

  /** @deprecated use exportCsvUrl('docs-pendentes') */
  docsPendentesExportCsvUrl() {
    return this.exportCsvUrl('docs-pendentes');
  },
};
