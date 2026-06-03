import { apiAuthHeaders } from './apiAuth';

export type ConsultorActivationCategory =
  | 'docs-pendentes'
  | 'financeiro'
  | 'provavel-evasao'
  | 'acessos-blackboard'
  | 'processos-caa'
  | 'aguardando-inicio';

export interface ConsultorStats {
  dispatches_sent: number;
  dispatches_not_found: number;
  dispatches_failed: number;
  unique_recipients: number;
  total_responses: number;
  unique_responders: number;
  unique_clickers: number;
  unique_opt_outs: number;
  response_rate: number;
  caa_revertidos: number;
  caa_perdidos: number;
  caa_taxa_reversao: number;
}

export interface ConsultorRow {
  key: string;
  consultor_id: number | null;
  consultor_nome: string | null;
  label: string;
  totals: ConsultorStats;
  by_category: Record<ConsultorActivationCategory, ConsultorStats>;
}

export interface ConsultoresReportResponse {
  filters: {
    period_days: number;
    category: string;
    attribution_window_days: number;
    since: string;
    now: string;
  };
  consultores: ConsultorRow[];
  generated_at: string;
}

async function jsonFetch<T>(url: string): Promise<T> {
  const r = await fetch(url, { headers: { Accept: 'application/json', ...apiAuthHeaders() } });
  if (!r.ok) {
    const txt = await r.text();
    throw new Error(txt || `Requisição falhou (${r.status})`);
  }
  return (await r.json()) as T;
}

export const consultorReportApi = {
  list(params: { periodDays?: number; category?: string; attributionWindowDays?: number } = {}) {
    const qs = new URLSearchParams();
    if (params.periodDays) qs.set('period_days', String(params.periodDays));
    if (params.category && params.category !== 'all') qs.set('category', params.category);
    if (params.attributionWindowDays)
      qs.set('attribution_window_days', String(params.attributionWindowDays));
    const url = `/api/reports/consultores${qs.toString() ? `?${qs.toString()}` : ''}`;
    return jsonFetch<ConsultoresReportResponse>(url);
  },
};
