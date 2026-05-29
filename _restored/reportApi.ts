import type { StudentDTO } from './studentApi';
import { jsonFetch } from './apiClient';

export type ReportSlug =
  | 'matriculados'
  | 'docs-pendentes'
  | 'financeiro'
  | 'acessos-blackboard'
  | 'processos-caa';

export interface ReportOverviewResponse {
  counts: Record<ReportSlug, number>;
}

export interface ReportListResponse {
  students: StudentDTO[];
  total: number;
  type: ReportSlug;
}

function qs(filters: { term_id?: string; polo?: string }) {
  const p = new URLSearchParams();
  if (filters.term_id) p.set('term_id', filters.term_id);
  if (filters.polo) p.set('polo', filters.polo);
  const s = p.toString();
  return s ? `?${s}` : '';
}

export const reportApi = {
  overview(filters: { term_id?: string; polo?: string } = {}) {
    return jsonFetch<ReportOverviewResponse>(`/api/reports/overview${qs(filters)}`);
  },

  list(
    type: ReportSlug,
    filters: { term_id?: string; polo?: string; limit?: number; offset?: number } = {}
  ) {
    const p = new URLSearchParams();
    if (filters.term_id) p.set('term_id', filters.term_id);
    if (filters.polo) p.set('polo', filters.polo);
    if (filters.limit != null) p.set('limit', String(filters.limit));
    if (filters.offset != null) p.set('offset', String(filters.offset));
    const q = p.toString();
    return jsonFetch<ReportListResponse>(`/api/reports/${type}${q ? `?${q}` : ''}`);
  },
};
