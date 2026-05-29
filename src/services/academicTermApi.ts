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

export type TipoInicio = 'imediato' | 'data_fixa' | 'proximo_mes' | 'manual';
export type LiberacaoAcesso = 'imediato' | 'D+1' | 'D+2' | 'custom';

export interface AcademicTermDTO {
  id: string;
  codigo: string;
  nome: string;
  descricao: string | null;
  nivel: string | null;
  ciclo: string | null;
  inicio_matricula: string | null;
  fim_matricula: string | null;
  inicio_conteudo: string | null;
  fim_conteudo: string | null;
  tem_ambientacao: boolean;
  dias_ambientacao: number;
  conteudo_previo_liberado: boolean;
  permitir_atraso: boolean;
  dias_atraso_max: number;
  tipo_inicio: TipoInicio;
  liberacao_acesso: LiberacaoAcesso;
  liberacao_acesso_dias: number;
  metadata: unknown;
  ativo: boolean;
  total_students?: number;
  created_at: string;
  updated_at: string;
}

export interface AcademicTermInput {
  codigo: string;
  nome: string;
  descricao?: string | null;
  nivel?: string | null;
  ciclo?: string | null;
  inicio_matricula?: string | null;
  fim_matricula?: string | null;
  inicio_conteudo?: string | null;
  fim_conteudo?: string | null;
  tem_ambientacao?: boolean;
  dias_ambientacao?: number;
  conteudo_previo_liberado?: boolean;
  permitir_atraso?: boolean;
  dias_atraso_max?: number;
  tipo_inicio?: TipoInicio;
  liberacao_acesso?: LiberacaoAcesso;
  liberacao_acesso_dias?: number;
  ativo?: boolean;
}

export const academicTermApi = {
  list({ ativoOnly, search, nivel, ciclo }: { ativoOnly?: boolean; search?: string; nivel?: string; ciclo?: string } = {}) {
    const qs = new URLSearchParams();
    if (ativoOnly) qs.set('ativoOnly', 'true');
    if (search) qs.set('search', search);
    if (nivel) qs.set('nivel', nivel);
    if (ciclo) qs.set('ciclo', ciclo);
    return jsonFetch<{ terms: AcademicTermDTO[] }>(`/api/academic-terms?${qs.toString()}`);
  },
  get(id: string) {
    return jsonFetch<{ term: AcademicTermDTO }>(`/api/academic-terms/${id}`);
  },
  create(input: AcademicTermInput) {
    return jsonFetch<{ term: AcademicTermDTO }>(`/api/academic-terms`, {
      method: 'POST',
      body: JSON.stringify(input),
    });
  },
  update(id: string, input: AcademicTermInput) {
    return jsonFetch<{ term: AcademicTermDTO }>(`/api/academic-terms/${id}`, {
      method: 'PUT',
      body: JSON.stringify(input),
    });
  },
  remove(id: string) {
    return jsonFetch<void>(`/api/academic-terms/${id}`, { method: 'DELETE' });
  },
  recalculateStudents(id: string) {
    return jsonFetch<{
      processed: number;
      errors: Array<{ studentId: string; error: string }>;
      fluxoCounts: { A: number; B: number; C: number; INDEFINIDO: number };
      totalEvents: number;
    }>(`/api/academic-terms/${id}/recalculate-students`, { method: 'POST' });
  },
};
