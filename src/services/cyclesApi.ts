import { fetchJson } from './httpJson';

export interface CycleStatus {
  ciclo: string;
  status: 'active' | 'frozen';
  frozen_at?: string;
  frozen_by?: string | null;
  reason?: string | null;
}

export interface CyclesListResponse {
  cycles: CycleStatus[];
}

export const cyclesApi = {
  list(): Promise<CyclesListResponse> {
    return fetchJson<CyclesListResponse>('/api/cycles');
  },
  freeze(ciclo: string, opts?: { reason?: string; by?: string }): Promise<{ ok: boolean; ciclo: string; frozen_at: string }> {
    return fetchJson<{ ok: boolean; ciclo: string; frozen_at: string }>(
      `/api/cycles/${encodeURIComponent(ciclo)}/freeze`,
      {
        method: 'POST',
        body: JSON.stringify({
          reason: opts?.reason ?? null,
          by: opts?.by ?? null,
        }),
      }
    );
  },
  unfreeze(ciclo: string): Promise<{ ok: boolean; ciclo: string; was_frozen: boolean }> {
    return fetchJson<{ ok: boolean; ciclo: string; was_frozen: boolean }>(
      `/api/cycles/${encodeURIComponent(ciclo)}/freeze`,
      { method: 'DELETE' }
    );
  },
};
