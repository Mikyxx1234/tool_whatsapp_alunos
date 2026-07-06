import { apiAuthHeaders } from './apiAuth';
import { getConsultoresCatalogo, readConsultorIdentity } from './meuPainelApi';

export type PainelMetaStatus = 'batendo' | 'em_risco' | 'atrasado' | 'sem_meta';

export interface PainelEquipeRow {
  ranking?: number;
  consultor_nome: string;
  total_marcado: number;
  total_revertido: number;
  total_confirmado: number;
  meta_diaria: number | null;
  meta_marcados: number | null;
  pct_meta: number | null;
  taxa_reversao: number | null;
  pendentes: number;
  pendentes_24h_plus: number;
  status_meta: PainelMetaStatus;
}

export interface PainelFunil {
  total_atribuido: number;
  total_marcado: number;
  total_revertido: number;
  total_responderam?: number;
  total_opt_out?: number;
  taxa_marcacao: number | null;
  taxa_reversao: number | null;
  taxa_resposta?: number | null;
}

export interface PainelPerfil {
  id: string;
  label: string;
  category: string;
  modo: 'caa' | 'operacional';
}

export interface PainelPerfilOption {
  id: string;
  label: string;
  modo: 'caa' | 'operacional';
}

export interface PainelProjecaoMeta {
  hour: number;
  elapsed_hours: number;
  total_hours: number;
  pct_dia: number;
  projecao_fim_dia: number | null;
  pct_projecao: number | null;
}

export interface PainelPendenteConsultor {
  consultor_nome: string;
  pendentes: number;
  age_0_4h: number;
  age_4_24h: number;
  age_1_3d: number;
  age_3d_plus: number;
}

export interface PainelAging {
  age_0_4h: number;
  age_4_24h: number;
  age_1_3d: number;
  age_3d_plus: number;
  total: number;
}

export interface PainelEvolucaoDia {
  dia: string;
  marcados: number;
  revertidos: number;
}

export interface PainelEvolucaoAtribuidosDia {
  dia: string;
  atribuidos: number;
  responderam: number;
}

export interface PainelDiarioDia {
  dia: string;
  disparos: number;
  pessoas: number;
  responderam: number;
  taxa_resposta: number | null;
}

export interface PainelDiarioResumo {
  dias_com_ativacao: number;
  total_disparos: number;
  total_pessoas: number;
  total_responderam: number;
  taxa_media_ponderada: number | null;
  taxa_media_dias: number | null;
}

export interface PainelDiarioSegmento {
  id: 'adimplente' | 'inadimplente';
  label: string;
  dias: PainelDiarioDia[];
  resumo: PainelDiarioResumo | null;
}

export interface PainelDiarioAtivacoes {
  dias: PainelDiarioDia[];
  resumo: PainelDiarioResumo | null;
  segmentos: PainelDiarioSegmento[] | null;
}

export interface PainelBaseRow {
  key: string;
  label: string;
  atribuidos: number;
  marcados: number;
  revertidos: number | null;
  taxa_marcacao: number | null;
  taxa_reversao: number | null;
  unique_dispatched?: number | null;
  unique_responders?: number | null;
  taxa_resposta?: number | null;
}

export interface PainelAlerta {
  tipo: 'success' | 'warning' | 'danger' | 'info';
  titulo: string;
  detalhe: string;
}

export interface PainelOverviewData {
  perfil: PainelPerfil;
  perfis_disponiveis: PainelPerfilOption[];
  evolucao_tipo: 'marcados' | 'atribuidos';
  period: {
    from: string | null;
    to: string | null;
    period_days: number | null;
    ano_mes_meta: string;
    meta_referencia_dia: string;
    ref_dia?: string | null;
    origem_ativacao?: string | null;
  };
  conversao: {
    total_dispatches: number;
    unique_dispatched: number;
    unique_responders: number;
    response_rate: number;
    unique_reverted: number;
  };
  meu_painel: {
    total_atribuido: number;
    total_marcado: number;
    total_revertido: number;
    total_confirmado: number;
    taxa_reversao: number;
  };
  equipe: PainelEquipeRow[];
  metas_resumo: {
    consultores_com_meta: number;
    meta_total: number;
    marcado_total: number;
    pct_meta_global: number | null;
    meta_tipo?: string;
  };
  funil: PainelFunil;
  projecao_meta: PainelProjecaoMeta;
  pendentes: {
    por_consultor: PainelPendenteConsultor[];
    aging: PainelAging;
    definicao?: string;
    escopo?: string;
  };
  evolucao_diaria: PainelEvolucaoDia[];
  diario_ativacoes: PainelDiarioAtivacoes;
  calendario_meta: PainelCalendarioMeta;
  por_base: PainelBaseRow[];
  alertas: PainelAlerta[];
  generated_at: string;
}

export type PainelCalendarioStatus =
  | 'bateu'
  | 'quase'
  | 'abaixo'
  | 'zero'
  | 'fim_semana'
  | 'sem_meta'
  | 'futuro';

export interface PainelCalendarioDia {
  dia: string;
  dow: number;
  marcados: number;
  revertidos: number;
  meta_dia: number;
  pct: number | null;
  status: PainelCalendarioStatus;
  hoje: boolean;
  fim_de_semana: boolean;
}

export interface PainelCalendarioMeta {
  dias: PainelCalendarioDia[];
  meta_dia: number;
  resumo: {
    dias_avaliados: number;
    dias_bateram: number;
    taxa_sucesso: number | null;
  };
}

export interface PainelOverviewResponse {
  ok: boolean;
  data: PainelOverviewData;
}

function authQuery(): string {
  const id = readConsultorIdentity();
  const p = new URLSearchParams();
  if (id.role) p.set('role', id.role);
  if (id.categoria) p.set('categoria', id.categoria);
  const qs = p.toString();
  return qs ? `?${qs}` : '';
}

export async function fetchPainelOverview(opts?: {
  from?: string | null;
  to?: string | null;
  period_days?: number;
  perfil?: string;
  ref_dia?: string | null;
  origem_ativacao?: string | null;
}): Promise<PainelOverviewData> {
  const p = new URLSearchParams(authQuery().replace(/^\?/, ''));
  if (opts?.from) p.set('from', opts.from);
  if (opts?.to) p.set('to', opts.to);
  if (opts?.period_days != null) p.set('period_days', String(opts.period_days));
  if (opts?.perfil) p.set('perfil', opts.perfil);
  if (opts?.ref_dia) p.set('ref_dia', opts.ref_dia);
  if (opts?.origem_ativacao) p.set('origem_ativacao', opts.origem_ativacao);
  const qs = p.toString();
  const catalogo = getConsultoresCatalogo();
  const res = await fetch(`/api/painel/overview${qs ? `?${qs}` : ''}`, {
    method: 'POST',
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/json',
      ...apiAuthHeaders(),
    },
    body: JSON.stringify({
      catalogo,
      perfil: opts?.perfil || 'caa',
      ref_dia: opts?.ref_dia || null,
      origem_ativacao: opts?.origem_ativacao || null,
    }),
  });
  const raw = await res.text();
  if (!raw.trim()) {
    throw new Error('API do painel não respondeu. Recarregue em alguns segundos.');
  }
  const json = JSON.parse(raw) as PainelOverviewResponse & { error?: string };
  if (!res.ok) throw new Error(json.error || 'Erro ao carregar painel');
  return json.data;
}
