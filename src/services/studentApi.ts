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

export interface StudentDTO {
  id: string;
  nome: string;
  telefone: string | null;
  telefone_normalizado: string | null;
  email: string | null;
  cpf: string | null;
  rgm: string | null;
  ciclo: string | null;
  tipo_matricula: string | null;
  instituicao: string | null;
  empresa: string | null;
  curso: string | null;
  polo: string | null;
  data_matricula: string | null;
  data_inicio_conteudo: string | null;
  data_acesso_liberado: string | null;
  override_data_inicio_conteudo: string | null;
  override_data_acesso_liberado: string | null;
  ultimo_acesso: string | null;
  ultimo_acesso_blackboard: string | null;
  minutos_acesso: number | null;
  total_interacoes: number | null;
  total_registros: number | null;
  fonte_dados: string | null;
  term_id: string | null;
  gap_dias: number | null;
  fluxo: 'A' | 'B' | 'C' | null;
  status: 'ativo' | 'iniciado' | 'inativo' | 'cancelado';
  engagement_score: number;
  created_at: string;
  updated_at: string;
}

export interface ImportStudentInput {
  nome: string;
  telefone?: string;
  email?: string;
  cpf?: string;
  curso?: string;
  polo?: string;
  data_matricula?: string;
  data_inicio_conteudo?: string;
  data_acesso_liberado?: string;
  ultimo_acesso?: string;
  raw_data?: Record<string, string>;
}

export interface ImportStudentsResponse {
  imported: number;
  updated: number;
  total: number;
  errors: Array<{ index?: number; studentId?: string; error: string }>;
  fluxoCounts: { A: number; B: number; C: number; INDEFINIDO: number };
  totalEventsGenerated: number;
  students: StudentDTO[];
}

export interface ListStudentsResponse {
  students: StudentDTO[];
}

export interface TimelineEvent {
  id: string;
  student_id: string;
  event_type: string;
  title: string | null;
  description: string | null;
  metadata: unknown;
  created_at: string;
}

export interface ImportBlackboardResponse {
  imported: number;
  updated: number;
  total: number;
  errors: Array<{ index?: number; error: string }>;
  fluxoCounts: { A: number; B: number; C: number; INDEFINIDO: number };
  totalEventsGenerated: number;
  accessOnly: boolean;
  term_id: string | null;
}

export const studentApi = {
  list({
    fluxo,
    status,
    search,
    term_id,
    polo,
    limit = 100,
    offset = 0,
  }: {
    fluxo?: string;
    status?: string;
    search?: string;
    term_id?: string;
    polo?: string;
    limit?: number;
    offset?: number;
  } = {}) {
    const qs = new URLSearchParams();
    if (fluxo) qs.set('fluxo', fluxo);
    if (status) qs.set('status', status);
    if (search) qs.set('search', search);
    if (term_id) qs.set('term_id', term_id);
    if (polo) qs.set('polo', polo);
    qs.set('limit', String(limit));
    qs.set('offset', String(offset));
    return jsonFetch<ListStudentsResponse>(`/api/students?${qs.toString()}`);
  },

  get(id: string) {
    return jsonFetch<{ student: StudentDTO }>(`/api/students/${id}`);
  },

  create(input: ImportStudentInput) {
    return jsonFetch<{ student: StudentDTO; created: boolean }>(`/api/students`, {
      method: 'POST',
      body: JSON.stringify(input),
    });
  },

  patch(id: string, partial: Partial<StudentDTO>) {
    return jsonFetch<{ student: StudentDTO }>(`/api/students/${id}`, {
      method: 'PATCH',
      body: JSON.stringify(partial),
    });
  },

  importBulk(payload: {
    students: ImportStudentInput[];
    generateJourney?: boolean;
    termId?: string;
  }) {
    return jsonFetch<ImportStudentsResponse>(`/api/students/import`, {
      method: 'POST',
      body: JSON.stringify(payload),
    });
  },

  importBlackboard(payload: {
    rows: Record<string, unknown>[];
    termId?: string;
    accessOnly?: boolean;
    generateJourney?: boolean;
  }) {
    return jsonFetch<ImportBlackboardResponse>(`/api/students/import-blackboard`, {
      method: 'POST',
      body: JSON.stringify(payload),
    });
  },

  recalculateJourney(id: string) {
    return jsonFetch(`/api/students/${id}/recalculate-journey`, { method: 'POST' });
  },

  cancelFutureEvents(id: string, reason?: string) {
    return jsonFetch<{ cancelled: number }>(
      `/api/students/${id}/cancel-future-events`,
      {
        method: 'POST',
        body: JSON.stringify({ reason }),
      }
    );
  },

  getTimeline(id: string, limit = 200) {
    return jsonFetch<{ timeline: TimelineEvent[] }>(
      `/api/students/${id}/timeline?limit=${limit}`
    );
  },

  getScheduledEvents(id: string) {
    return jsonFetch<{ events: ScheduledEventDTO[] }>(
      `/api/students/${id}/scheduled-events`
    );
  },
};

export interface ScheduledEventDTO {
  id: string;
  student_id: string;
  campaign_id: string | null;
  template_id: string | null;
  canal: string;
  event_type: string | null;
  execution_date: string;
  status: 'pending' | 'processing' | 'sent' | 'failed' | 'cancelled' | 'skipped';
  attempts: number;
  max_attempts: number;
  last_error: string | null;
  processed_at: string | null;
  metadata: unknown;
  created_at: string;
}
