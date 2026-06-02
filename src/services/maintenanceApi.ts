import { apiAuthHeaders } from './apiAuth';

export interface CleanStaleOrigemAtivacaoResponse {
  scanned: number;
  cleaned: number;
  failed: number;
  errors: Array<{ lead_id: string; error: string }>;
  stale_window_hours: number;
  crm_rate_per_second: number;
  dry_run: boolean;
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
};
