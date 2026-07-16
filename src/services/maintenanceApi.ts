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
};
