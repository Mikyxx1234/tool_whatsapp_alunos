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

export interface JourneySettingsDTO {
  id: string;
  term_id: string | null;
  scope: 'GLOBAL' | 'TERM';
  gap_threshold_a: number;
  gap_threshold_b: number;
  ambientacao_ativa: boolean;
  ambientacao_obrigatoria: boolean;
  ambientacao_dias: number;
  conteudo_previo_ativo: boolean;
  delay_inicio_ativo: boolean;
  delay_inicio_max_dias: number;
  delay_inicio_acao: 'avisar' | 'ajustar' | 'ambos';
  liberacao_acesso: 'imediato' | 'D+1' | 'D+2' | 'custom';
  liberacao_acesso_dias: number;
  inativo_dias: number;
  caa_janela_t0: 'data_chegada' | 'primeiro_export' | 'primeiro_envio';
  caa_janela_dias_tipo: 'corridos' | 'uteis';
  bb_nao_acessa_dias: number;
  bb_acessou_pouco_minutos: number;
  bb_acessou_pouco_interacoes: number;
  raw_config: unknown;
  created_at: string;
  updated_at: string;
}

export interface JourneySettingsPatch {
  gap_threshold_a?: number;
  gap_threshold_b?: number;
  ambientacao_ativa?: boolean;
  ambientacao_obrigatoria?: boolean;
  ambientacao_dias?: number;
  conteudo_previo_ativo?: boolean;
  delay_inicio_ativo?: boolean;
  delay_inicio_max_dias?: number;
  delay_inicio_acao?: 'avisar' | 'ajustar' | 'ambos';
  liberacao_acesso?: 'imediato' | 'D+1' | 'D+2' | 'custom';
  liberacao_acesso_dias?: number;
  inativo_dias?: number;
  caa_janela_t0?: 'data_chegada' | 'primeiro_export' | 'primeiro_envio';
  caa_janela_dias_tipo?: 'corridos' | 'uteis';
  bb_nao_acessa_dias?: number;
  bb_acessou_pouco_minutos?: number;
  bb_acessou_pouco_interacoes?: number;
}

export interface PreviewImpactResponse {
  thresholds: { a: number; b: number };
  term_id: string | null;
  fluxoCounts: { A: number; B: number; C: number };
  total_classificable: number;
}

export const journeySettingsApi = {
  getGlobal() {
    return jsonFetch<{ settings: JourneySettingsDTO | null }>(`/api/journey-settings/global`);
  },
  getByTerm(termId: string) {
    return jsonFetch<{ settings: JourneySettingsDTO | null }>(
      `/api/journey-settings/term/${termId}`
    );
  },
  putGlobal(patch: JourneySettingsPatch) {
    return jsonFetch<{ settings: JourneySettingsDTO }>(`/api/journey-settings/global`, {
      method: 'PUT',
      body: JSON.stringify(patch),
    });
  },
  putByTerm(termId: string, patch: JourneySettingsPatch) {
    return jsonFetch<{ settings: JourneySettingsDTO }>(
      `/api/journey-settings/term/${termId}`,
      { method: 'PUT', body: JSON.stringify(patch) }
    );
  },
  previewImpact(payload: {
    gap_threshold_a: number;
    gap_threshold_b: number;
    term_id?: string | null;
  }) {
    return jsonFetch<PreviewImpactResponse>(`/api/journey-settings/preview-impact`, {
      method: 'POST',
      body: JSON.stringify(payload),
    });
  },
};
