import { apiAuthHeaders } from './apiAuth';

export interface ConsultorRow {
  consultor_nome: string | null;
  caa_revertidos: number;
  caa_perdidos: number;
  caa_taxa_reversao: number;
  total_respostas: number;
  ultima_atribuicao: string | null;
}

export interface ConsultoresReportResponse {
  consultores: ConsultorRow[];
  filters: { period_days: number; since: string; now: string };
  totals: { caa_revertidos: number; caa_perdidos: number; total_respostas: number };
  generated_at: string;
}

export const consultorReportApi = {
  async list(opts: { period_days?: number } = {}): Promise<ConsultoresReportResponse> {
    const params = new URLSearchParams();
    if (opts.period_days) params.set('period_days', String(opts.period_days));
    const url = `/api/reports/consultores${params.toString() ? `?${params}` : ''}`;
    const res = await fetch(url, { headers: apiAuthHeaders() });
    if (!res.ok) throw new Error(`Falha ao carregar relatório: ${res.status}`);
    return (await res.json()) as ConsultoresReportResponse;
  },
};
