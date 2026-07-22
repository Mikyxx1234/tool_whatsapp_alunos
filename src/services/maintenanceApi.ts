import { apiAuthHeaders } from './apiAuth';

export interface CleanStaleOrigemAtivacaoResponse {
  scanned: number;
  from_log?: number;
  from_dispatch_only?: number;
  cleaned: number;
  failed: number;
  errors: Array<{ lead_id: string; error: string }>;
  stale_window_hours: number;
  crm_rate_per_second: number;
  dry_run: boolean;
  ran_at: string;
}

export interface CleanStaleActivationTagsResponse {
  scanned: number;
  cleaned: number;
  failed: number;
  errors: Array<{ contact_id: string; tag_name: string; error: string }>;
  stale_window_hours: number;
  dry_run: boolean;
  skipped_no_config?: boolean;
  ran_at: string;
}

export interface SyncCrmDesfechosResponse {
  scanned: number;
  synced_revertido: number;
  synced_confirmado: number;
  ignored: number;
  failed: number;
  errors: Array<{ lead_id: string; error: string }>;
  lookback_days: number;
  dry_run: boolean;
  ran_at: string;
  crm_rate_per_second: number;
  skipped_no_config?: boolean;
}

export interface DatacrazyCacheSyncLastRun {
  id: string;
  started_at: string;
  finished_at: string | null;
  pages: number;
  leads_seen: number;
  leads_upserted: number;
  leads_skipped: number;
  status: string;
  error_message: string | null;
}

export interface DatacrazyCacheStatusResponse {
  ok: boolean;
  cache_count: number;
  running: boolean;
  running_since: string | null;
  last_sync: DatacrazyCacheSyncLastRun | null;
}

export interface SyncDatacrazyCacheResponse {
  logId: string;
  pages: number;
  leadsSeen: number;
  upserted: number;
  skipped: number;
  durationMs: number;
  dry_run: boolean;
}

export interface StartDatacrazyCacheSyncResponse {
  ok: boolean;
  status: 'running';
  dry_run: boolean;
}

export interface NovoCrmCacheRunningSync {
  id: string;
  mode: 'full' | 'incremental';
  started_at: string;
  contacts_total: number | null;
  contacts_seen: number | null;
  cache_upserted: number | null;
  batches_scanned: number | null;
  progress_updated_at: string | null;
}

export interface NovoCrmCacheLastSync {
  id: string;
  mode: 'full' | 'incremental';
  started_at: string;
  finished_at: string | null;
  contacts_total: number | null;
  contacts_seen: number;
  cache_upserted: number;
  cache_skipped: number;
  contacts_deleted: number;
  data_loss_events: number;
  status: string;
  error_message: string | null;
}

export interface NovoCrmCacheStatusResponse {
  ok: boolean;
  cache_total: number;
  cache_active: number;
  missing_cpf: number;
  missing_rgm: number;
  incomplete_fields: number;
  running: boolean;
  running_sync: NovoCrmCacheRunningSync | null;
  last_sync: NovoCrmCacheLastSync | null;
  state: { cursor_updated_at: string | null } | null;
  open_data_loss_events: number;
}

export interface StartNovoCrmCacheSyncResponse {
  ok: boolean;
  status: 'running';
  mode: 'full' | 'incremental';
  dry_run: boolean;
}

export type NovoCrmEnrichScope = 'cpf' | 'rgm' | 'incomplete' | 'all_mapped';

export interface NovoCrmEnrichPreviewResponse {
  ok: boolean;
  dry_run: boolean;
  scope: NovoCrmEnrichScope | string;
  matriculados_snapshot_id: string;
  matriculados_file: string | null;
  matriculados_rows: number | null;
  index: { by_cpf: number; by_rgm: number; by_phone: number };
  candidates: number;
  matched: number;
  no_match: number;
  would_update: number;
  skipped_no_fill: number;
  updated: number;
  errors: number;
  would_fill_by_field: Record<string, number>;
  sample: Array<{
    contact_id: string;
    deal_id: string | null;
    nome: string | null;
    fields: string[];
    contact_patch: string[];
  }>;
  error_samples: Array<{ contact_id: string; error: string }>;
}

export interface NovoCrmEnrichStartResponse {
  ok: boolean;
  status: 'running';
  jobId: string;
  scope: string;
  dry_run: boolean;
}

export interface NovoCrmEnrichJobStatusResponse {
  ok: boolean;
  running: boolean;
  job: {
    jobId: string;
    scope: string;
    status: string;
    dry_run: boolean;
    total: number;
    processed: number;
    sent: number;
    failed: number;
    skipped: number;
    phase: string | null;
    status_message: string | null;
    started_at: string;
    finished_at: string | null;
    error: string | null;
    result: NovoCrmEnrichPreviewResponse | null;
  } | null;
}

export type NovoCrmFlagsStageMode = 'flags_stage' | 'fields' | 'both';

export interface NovoCrmFlagsStagePreviewResponse {
  ok: boolean;
  dry_run: boolean;
  mode: NovoCrmFlagsStageMode | string;
  scanned: number;
  matched: number;
  flags_updated: number;
  fields_updated: number;
  stages_moved: number;
  stages_skipped_untouchable: number;
  skipped_no_match: number;
  skipped_no_deal: number;
  errors: number;
  samples: Array<{
    dealId?: string;
    cpf?: string;
    rgm?: string;
    from?: string | null;
    to?: string;
    move?: boolean;
    moved?: boolean;
    untouchable?: boolean;
    flags?: Record<string, boolean>;
  }>;
  error_samples: Array<{ dealId?: string; cpf?: string; error: string }>;
}

export interface NovoCrmFlagsStageStartResponse {
  ok: boolean;
  status: 'running';
  jobId: string;
  dry_run: boolean;
  mode: string;
}

export interface NovoCrmFlagsStageJobStatusResponse {
  ok: boolean;
  running: boolean;
  job: {
    jobId: string;
    mode: string;
    status: string;
    dry_run: boolean;
    total: number;
    processed: number;
    sent: number;
    phase: string | null;
    status_message: string | null;
    started_at: string;
    finished_at: string | null;
    error: string | null;
    result: NovoCrmFlagsStagePreviewResponse | null;
  } | null;
}

export interface NovoCrmRegressionEvent {
  id: string | number;
  contact_id?: string;
  detected_at?: string;
  removed_paths?: unknown;
  acknowledged_at?: string | null;
}

export interface NovoCrmRegressionsResponse {
  ok: boolean;
  events: NovoCrmRegressionEvent[];
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
    throw new Error(payload?.error || `Requisição falhou (${response.status})`);
  }
  return data as T;
}

export const maintenanceApi = {
  cleanStaleOrigemAtivacao(opts?: { dryRun?: boolean }) {
    const qs = opts?.dryRun ? '?dry_run=true' : '';
    return jsonFetch<CleanStaleOrigemAtivacaoResponse>(
      `/api/maintenance/clean-stale-origem-ativacao${qs}`,
      { method: 'POST', body: '{}' }
    );
  },

  cleanStaleActivationTags(opts?: { dryRun?: boolean }) {
    const qs = opts?.dryRun ? '?dry_run=true' : '';
    return jsonFetch<CleanStaleActivationTagsResponse>(
      `/api/maintenance/clean-stale-activation-tags${qs}`,
      { method: 'POST', body: '{}' }
    );
  },

  syncCrmDesfechos(opts?: { dryRun?: boolean; days?: number }) {
    const params = new URLSearchParams();
    if (opts?.dryRun) params.set('dry_run', 'true');
    if (opts?.days != null) params.set('days', String(opts.days));
    const qs = params.toString() ? `?${params.toString()}` : '';
    return jsonFetch<SyncCrmDesfechosResponse>(
      `/api/maintenance/sync-crm-desfechos${qs}`,
      { method: 'POST', body: '{}' }
    );
  },

  getDatacrazyCacheStatus() {
    return jsonFetch<DatacrazyCacheStatusResponse>('/api/maintenance/datacrazy-cache-status');
  },

  /** Sync em background — retorna 202; acompanhe com getDatacrazyCacheStatus(). */
  startDatacrazyCacheSync(opts?: { dryRun?: boolean }) {
    const qs = opts?.dryRun ? '?async=1&dryRun=1' : '?async=1';
    return jsonFetch<StartDatacrazyCacheSyncResponse>(
      `/api/maintenance/sync-datacrazy-cache${qs}`,
      { method: 'POST', body: '{}' }
    );
  },

  /** Sync bloqueante (uso em scripts; pode levar vários minutos). */
  syncDatacrazyCacheBlocking(opts?: { dryRun?: boolean }) {
    const qs = opts?.dryRun ? '?dryRun=1' : '';
    return jsonFetch<SyncDatacrazyCacheResponse>(
      `/api/maintenance/sync-datacrazy-cache${qs}`,
      { method: 'POST', body: '{}' }
    );
  },

  getNovoCrmCacheStatus() {
    return jsonFetch<NovoCrmCacheStatusResponse>('/api/maintenance/novo-crm-cache-status');
  },

  /** Sync do espelho Novo CRM em background — retorna 202; acompanhe com getNovoCrmCacheStatus(). */
  startNovoCrmCacheSync(opts?: { mode?: 'full' | 'incremental' }) {
    const params = new URLSearchParams({ async: '1', mode: opts?.mode || 'full' });
    return jsonFetch<StartNovoCrmCacheSyncResponse>(
      `/api/maintenance/sync-novo-crm-cache?${params.toString()}`,
      { method: 'POST', body: '{}' }
    );
  },

  previewNovoCrmEnrich(scope: NovoCrmEnrichScope) {
    const params = new URLSearchParams({ scope, dry_run: '1' });
    return jsonFetch<NovoCrmEnrichPreviewResponse>(
      `/api/maintenance/enrich-novo-crm?${params.toString()}`,
      { method: 'POST', body: '{}' }
    );
  },

  startNovoCrmEnrichApply(scope: NovoCrmEnrichScope) {
    const params = new URLSearchParams({ scope, dry_run: '0', async: '1' });
    return jsonFetch<NovoCrmEnrichStartResponse>(
      `/api/maintenance/enrich-novo-crm?${params.toString()}`,
      { method: 'POST', body: '{}' }
    );
  },

  getNovoCrmEnrichStatus(jobId?: string) {
    const qs = jobId ? `?jobId=${encodeURIComponent(jobId)}` : '';
    return jsonFetch<NovoCrmEnrichJobStatusResponse>(
      `/api/maintenance/enrich-novo-crm-status${qs}`
    );
  },

  listNovoCrmRegressions(opts?: { limit?: number }) {
    const params = new URLSearchParams();
    if (opts?.limit != null) params.set('limit', String(opts.limit));
    const qs = params.toString() ? `?${params}` : '';
    return jsonFetch<NovoCrmRegressionsResponse>(
      `/api/maintenance/novo-crm-cache-regressions${qs}`
    );
  },

  ackNovoCrmRegression(id: string | number) {
    return jsonFetch<{ ok: boolean; event: NovoCrmRegressionEvent }>(
      `/api/maintenance/novo-crm-cache-regressions/${encodeURIComponent(String(id))}/ack`,
      { method: 'POST', body: '{}' }
    );
  },

  /** Prévia: flags + etapas (dry_run). */
  previewNovoCrmFlagsStage(opts?: { mode?: 'flags_stage' | 'fields' | 'both'; max?: number }) {
    const params = new URLSearchParams({
      dry_run: '1',
      mode: opts?.mode || 'flags_stage',
    });
    if (opts?.max != null) params.set('max', String(opts.max));
    return jsonFetch<NovoCrmFlagsStagePreviewResponse>(
      `/api/maintenance/sync-flags-stage-novo-crm?${params.toString()}`,
      { method: 'POST', body: '{}' }
    );
  },

  /** Aplica flags + etapas em background. */
  startNovoCrmFlagsStage(opts?: { mode?: 'flags_stage' | 'fields' | 'both'; max?: number }) {
    const params = new URLSearchParams({
      dry_run: '0',
      async: '1',
      mode: opts?.mode || 'flags_stage',
    });
    if (opts?.max != null) params.set('max', String(opts.max));
    return jsonFetch<NovoCrmFlagsStageStartResponse>(
      `/api/maintenance/sync-flags-stage-novo-crm?${params.toString()}`,
      { method: 'POST', body: '{}' }
    );
  },

  getNovoCrmFlagsStageStatus(jobId?: string) {
    const qs = jobId ? `?jobId=${encodeURIComponent(jobId)}` : '';
    return jsonFetch<NovoCrmFlagsStageJobStatusResponse>(
      `/api/maintenance/sync-flags-stage-novo-crm-status${qs}`
    );
  },
};
