import { apiAuthHeaders } from './apiAuth';

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
    const payload = data as { error?: string; code?: string };
    const message = payload?.error || `Requisição falhou (${response.status})`;
    const err = new Error(message) as Error & { code?: string };
    if (payload?.code) err.code = payload.code;
    throw err;
  }
  return data as T;
}

export type ActivationCategory =
  | 'docs-pendentes'
  | 'financeiro'
  | 'provavel-evasao'
  | 'acessos-blackboard'
  | 'processos-caa'
  | 'aguardando-inicio';

export type BbSubgrupo =
  | 'podia_e_nao_acessou'
  | 'nao_acessa_faz_tempo'
  | 'acessou_pouco';

export type ActivationTemplateTier = 'first' | 'repeat' | 'fifth';

export type ActivationTemplateConfigMap = Partial<
  Record<
    ActivationCategory,
    Partial<Record<ActivationTemplateTier, string>>
  >
>;

export interface ActivationTemplateConfigResponse {
  config: ActivationTemplateConfigMap;
}

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
  master_key?: string;
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
  intersection_raw?: number;
  skipped_already_dispatched?: number;
  skipped_duplicate_key?: number;
  skipped_ciclo_divergente?: number;
  skipped_bb_limbo?: number;
  already_dispatched_in_db?: number;
  exclude_dispatched?: boolean;
  generated_at: string;
}

export interface EnrichedActivationItem extends ActivationListItem {
  datacrazy_found: boolean;
  datacrazy: DatacrazyLeadSummary | null;
  datacrazy_error?: string;
}

export type ActivationMessageTier = 'first' | 'repeat' | 'fifth';

/** Mesmos grupos dos templates: 1ª, reativação (2ª–4ª), 5ª+. */
export type ActivationStageFilter = 'all' | 'first' | 'repeat' | 'fifth';

export type ActivationResponseKind = 'click' | 'message' | 'opt_out' | 'other';

export interface CaaJanelaInfo {
  t0: string | null;
  expires_at: string | null;
  t0_source: 'data_chegada' | 'primeiro_export' | 'primeiro_envio';
  dias_tipo: 'corridos' | 'uteis';
}

export interface ActivationRosterItem extends ActivationListItem {
  prior_activation_count: number;
  message_tier: ActivationMessageTier;
  message_tier_label: string;
  template_name: string | null;
  template_configured: boolean;
  last_response_at?: string;
  last_response_kind?: ActivationResponseKind;
  last_response_button?: string | null;
  bb_urgency?: 'alta' | 'media' | 'normal' | 'sem_turma';
  bb_dias_apos_inicio?: number | null;
  bb_term_codigo?: string | null;
  bb_subgrupo?: BbSubgrupo;
  dias_ate_inicio?: number | null;
  caa_janela?: CaaJanelaInfo | null;
}

export interface ActivationRosterResponse {
  category: ActivationCategory;
  total: number;
  total_unfiltered?: number;
  activation_stage?: ActivationStageFilter;
  items: ActivationRosterItem[];
  offset: number;
  limit: number;
  generated_at: string;
  /** Quantos alunos ficaram fora da fila BB porque a turma deles ainda não começou. */
  skipped_bb_limbo?: number;
  skipped_ciclo_divergente?: number;
  bb_urgency_counts?: { alta: number; media: number; normal: number; sem_turma: number };
  bb_subgrupo_counts?: {
    podia_e_nao_acessou: number;
    nao_acessa_faz_tempo: number;
    acessou_pouco: number;
  };
  /** Ciclos distintos presentes no snapshot de matriculados (antes do filtro de ciclo). */
  available_ciclos?: string[];
  /** Contagem de alunos por ciclo na fila completa (antes de qualquer filtro). */
  counts_by_ciclo?: Record<string, number>;
}

export interface DatacrazyBatchNotFoundItem extends ActivationListItem {
  message_tier?: ActivationMessageTier;
  template_name?: string | null;
}

export interface DatacrazyBatchResponse {
  category: ActivationCategory;
  processed: number;
  sent: number;
  not_found: number;
  failed: number;
  skipped: number;
  not_found_items: DatacrazyBatchNotFoundItem[];
  results: Array<
    ActivationRosterItem & {
      status: string;
      error?: string;
      datacrazy?: DatacrazyLeadSummary | null;
    }
  >;
  datacrazy_pages?: number;
  datacrazy_leads_scanned?: number;
  /** Disparo interrompido porque origem_ativacao não gravou no CRM. */
  origem_ativacao_blocked?: boolean;
  origem_ativacao_error?: string | null;
  message?: string | null;
}

export interface ActivationJobProgress {
  jobId: string;
  category: ActivationCategory;
  status: 'running' | 'completed' | 'failed';
  total: number;
  processed: number;
  sent: number;
  failed: number;
  not_found: number;
  skipped: number;
  scanned: number | null;
  pages: number | null;
  started_at: string;
  finished_at: string | null;
  result: DatacrazyBatchResponse | null;
  error: string | null;
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
  getTemplateConfig() {
    return jsonFetch<ActivationTemplateConfigResponse>('/api/activation/template-config');
  },

  warmRoster(category: ActivationCategory) {
    return jsonFetch<{ ok: boolean; warming: boolean; category: string }>(
      `/api/activation/${category}/warm`,
      { method: 'POST', body: '{}' }
    );
  },

  setTemplateConfig(
    category: ActivationCategory,
    patch: Partial<Record<ActivationTemplateTier, string | null>>
  ) {
    return jsonFetch<ActivationTemplateConfigResponse & { ok: boolean }>(
      `/api/activation/template-config/${category}`,
      {
        method: 'PUT',
        body: JSON.stringify(patch),
      }
    );
  },

  list(category: ActivationCategory, opts?: { includeSent?: boolean }) {
    const q = opts?.includeSent ? '?include_sent=true' : '';
    return jsonFetch<ActivationListResponse>(`/api/activation/${category}/list${q}`);
  },

  markDispatched(
    category: ActivationCategory,
    opts?: { masterKeys?: string[]; markAllEligible?: boolean }
  ) {
    return jsonFetch<{ category: string; registered: number; keys_submitted: number }>(
      `/api/activation/${category}/mark-dispatched`,
      {
        method: 'POST',
        body: JSON.stringify({
          master_keys: opts?.masterKeys,
          mark_all_eligible: opts?.markAllEligible ?? false,
        }),
      }
    );
  },

  roster(
    category: ActivationCategory,
    opts?: {
      limit?: number;
      offset?: number;
      activationStage?: ActivationStageFilter;
      bbSubgrupo?: BbSubgrupo | 'all';
      ciclo?: string;
    }
  ) {
    const params = new URLSearchParams();
    if (opts?.limit != null) params.set('limit', String(opts.limit));
    if (opts?.offset != null) params.set('offset', String(opts.offset));
    if (opts?.activationStage && opts.activationStage !== 'all') {
      params.set('activation_stage', opts.activationStage);
    }
    if (opts?.bbSubgrupo && opts.bbSubgrupo !== 'all') {
      params.set('bb_subgrupo', opts.bbSubgrupo);
    }
    if (opts?.ciclo) {
      params.set('ciclo', opts.ciclo);
    }
    const q = params.toString() ? `?${params}` : '';
    return jsonFetch<ActivationRosterResponse>(`/api/activation/${category}/roster${q}`);
  },

  runDatacrazyBatch(
    category: ActivationCategory,
    opts?: { limit?: number; masterKeys?: string[] }
  ) {
    const body: Record<string, unknown> = { limit: opts?.limit ?? 0 };
    if (Array.isArray(opts?.masterKeys) && opts!.masterKeys!.length > 0) {
      body.master_keys = opts!.masterKeys;
    }
    return jsonFetch<DatacrazyBatchResponse>(`/api/activation/${category}/run-datacrazy-batch`, {
      method: 'POST',
      body: JSON.stringify(body),
    });
  },

  runDatacrazyBatchAsync(
    category: ActivationCategory,
    opts?: { masterKeys?: string[] }
  ): Promise<{ jobId: string; status: 'running' }> {
    const body: Record<string, unknown> = { limit: 0 };
    if (Array.isArray(opts?.masterKeys) && opts!.masterKeys!.length > 0) {
      body.master_keys = opts!.masterKeys;
    }
    return jsonFetch<{ jobId: string; status: 'running' }>(
      `/api/activation/${category}/run-datacrazy-batch?async=1`,
      { method: 'POST', body: JSON.stringify(body) }
    );
  },

  getJobProgress(jobId: string): Promise<ActivationJobProgress> {
    return jsonFetch<ActivationJobProgress>(`/api/activation/jobs/${jobId}/progress`);
  },

  async downloadNotFoundCsv(category: ActivationCategory, items: DatacrazyBatchNotFoundItem[]) {
    const res = await fetch(`/api/activation/${category}/not-found-export.csv`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'text/csv' },
      body: JSON.stringify({ items }),
    });
    if (!res.ok) {
      const t = await res.text();
      throw new Error(t || `Falha ao gerar CSV (${res.status})`);
    }
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `ativacao-${category}-nao-encontrados-datacrazy.csv`;
    a.click();
    URL.revokeObjectURL(url);
  },

  datacrazyEnrich(category: ActivationCategory, opts?: { offset?: number; limit?: number }) {
    return jsonFetch<DatacrazyEnrichResponse>(`/api/activation/${category}/datacrazy`, {
      method: 'POST',
      body: JSON.stringify({ offset: opts?.offset ?? 0, limit: opts?.limit ?? 0 }),
    });
  },

  exportCsvUrl(category: ActivationCategory, opts?: { includeSent?: boolean }) {
    const q = opts?.includeSent ? '?include_sent=true' : '';
    return `/api/activation/${category}/export.csv${q}`;
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
