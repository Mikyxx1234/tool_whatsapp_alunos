import { useCallback, useEffect, useState } from 'react';
import { RefreshCw, Target } from 'lucide-react';
import {
  reportApi,
  type CaaFunnelEstado,
  type CaaFunnelItem,
  type CaaFunnelCounts,
  type CaaFunnelResponse,
} from '../services/reportApi';

// ─── Configuração de visual por estado ────────────────────────────────────────

const ESTADO_CONFIG: Record<
  CaaFunnelEstado,
  { label: string; short: string; badge: string; card: string }
> = {
  ativavel: {
    label: 'Ativável agora',
    short: 'Ativável',
    badge: 'bg-sky-50 text-sky-700 border-sky-200',
    card: 'border-sky-200 bg-sky-50 text-sky-800',
  },
  perdido_silencioso: {
    label: 'Perdido na janela',
    short: 'Janela vencida',
    badge: 'bg-amber-50 text-amber-800 border-amber-300',
    card: 'border-amber-300 bg-amber-50 text-amber-900',
  },
  revertido_manual: {
    label: 'Revertido (desfecho)',
    short: 'Revertido manual',
    badge: 'bg-emerald-50 text-emerald-700 border-emerald-200',
    card: 'border-emerald-200 bg-emerald-50 text-emerald-800',
  },
  perdido_manual: {
    label: 'Perdido (desfecho)',
    short: 'Perdido manual',
    badge: 'bg-rose-50 text-rose-700 border-rose-200',
    card: 'border-rose-200 bg-rose-50 text-rose-800',
  },
  revertido_export: {
    label: 'Revertido pelo CAA',
    short: 'Revertido CAA',
    badge: 'bg-emerald-100 text-emerald-800 border-emerald-300',
    card: 'border-emerald-300 bg-emerald-100 text-emerald-900',
  },
  perdido_export: {
    label: 'Perdido pelo CAA',
    short: 'Perdido CAA',
    badge: 'bg-rose-100 text-rose-800 border-rose-300',
    card: 'border-rose-100 bg-rose-50 text-rose-900',
  },
  unknown: {
    label: 'Desconhecido',
    short: 'Unknown',
    badge: 'bg-gray-100 text-gray-600 border-gray-200',
    card: 'border-gray-200 bg-gray-50 text-gray-700',
  },
};

const ESTADOS_FUNIL: CaaFunnelEstado[] = [
  'ativavel',
  'perdido_silencioso',
  'revertido_manual',
  'perdido_manual',
  'revertido_export',
  'perdido_export',
];

const OUTCOME_LABEL: Record<string, string> = {
  revertido: 'Revertido',
  confirmado: 'Confirmado',
  sem_contato: 'Sem contato',
  outro: 'Outro',
};

// ─── Helpers ──────────────────────────────────────────────────────────────────

function fmtDateTime(iso: string | null | undefined): string {
  if (!iso) return '—';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '—' : d.toLocaleString('pt-BR');
}

function JanelaBadge({ item }: { item: CaaFunnelItem }) {
  if (!item.expires_at) return <span className="text-gray-400">—</span>;
  const h = item.horas_restantes ?? 0;
  if (h >= 0) {
    const hInt = Math.floor(h);
    return (
      <span className="inline-block px-2 py-0.5 rounded-full text-[11px] border bg-sky-50 text-sky-700 border-sky-200">
        vence em {hInt}h
      </span>
    );
  }
  const hAbs = Math.floor(Math.abs(h));
  return (
    <span className="inline-block px-2 py-0.5 rounded-full text-[11px] border bg-amber-50 text-amber-800 border-amber-300">
      vencida há {hAbs}h
    </span>
  );
}

function EstadoBadge({ estado }: { estado: CaaFunnelEstado }) {
  const cfg = ESTADO_CONFIG[estado] ?? ESTADO_CONFIG.unknown;
  return (
    <span
      className={`inline-block px-2 py-0.5 rounded-full text-[11px] border ${cfg.badge}`}
    >
      {cfg.short}
    </span>
  );
}

// ─── Componente principal ──────────────────────────────────────────────────────

export function CaaFunnelPanel() {
  const [data, setData] = useState<CaaFunnelResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Filtros locais
  const [estadoFilter, setEstadoFilter] = useState<CaaFunnelEstado | 'todos'>('todos');
  const [soEngajados, setSoEngajados] = useState(false);
  const [soConflito, setSoConflito] = useState(false);
  const [cicloFilter, setCicloFilter] = useState('all');
  const [page, setPage] = useState(0);

  const LIMIT = 50;

  const load = useCallback(
    async (
      estado: CaaFunnelEstado | 'todos',
      engajado: boolean,
      conflito: boolean,
      ciclo: string,
      offset: number
    ) => {
      setLoading(true);
      setError(null);
      try {
        const result = await reportApi.caaFunnel({
          estado: estado === 'todos' ? undefined : estado,
          engajado: engajado ? true : undefined,
          conflito: conflito ? true : undefined,
          ciclo: ciclo !== 'all' ? ciclo : undefined,
          limit: LIMIT,
          offset,
        });
        setData(result);
      } catch (e) {
        setError(e instanceof Error ? e.message : 'Erro ao carregar funil CAA');
      } finally {
        setLoading(false);
      }
    },
    []
  );

  useEffect(() => {
    void load(estadoFilter, soEngajados, soConflito, cicloFilter, page * LIMIT);
  }, [load, estadoFilter, soEngajados, soConflito, cicloFilter, page]);

  const handleFilterChange = (
    novoEstado?: CaaFunnelEstado | 'todos',
    novoEng?: boolean,
    novoConf?: boolean
  ) => {
    if (novoEstado !== undefined) setEstadoFilter(novoEstado);
    if (novoEng !== undefined) setSoEngajados(novoEng);
    if (novoConf !== undefined) setSoConflito(novoConf);
    setPage(0);
  };

  const counts: CaaFunnelCounts = data?.counts ?? {
    ativavel: 0,
    perdido_silencioso: 0,
    revertido_manual: 0,
    perdido_manual: 0,
    revertido_export: 0,
    perdido_export: 0,
    unknown: 0,
    total_no_funil: 0,
    engajados: 0,
    com_conflito: 0,
  };

  const availableCiclos = data?.available_ciclos ?? [];
  const countsByCiclo = data?.counts_by_ciclo ?? {};

  const buildCicloBreakdown = (key: keyof CaaFunnelCounts) => {
    if (cicloFilter !== 'all' || availableCiclos.length <= 1) return undefined;
    if (Object.keys(countsByCiclo).length === 0) return undefined;
    return availableCiclos.map((c) => ({
      ciclo: c,
      value: Number(countsByCiclo[c]?.[key] ?? 0),
    }));
  };

  const totalPages = data ? Math.ceil(data.total_items / LIMIT) : 0;

  return (
    <section className="bg-white rounded-xl border border-gray-100 shadow-sm">
      {/* Cabeçalho */}
      <header className="flex flex-wrap items-center justify-between gap-3 px-5 py-4 border-b border-gray-100">
        <div className="flex items-center gap-2">
          <Target className="w-5 h-5 text-sky-600" />
          <div>
            <h3 className="text-base font-semibold text-gray-900">
              Funil CAA — base estoque
              {data && (
                <span className="ml-1 text-gray-500 font-normal">
                  ({counts.total_no_funil.toLocaleString('pt-BR')} protocolos)
                </span>
              )}
            </h3>
            {data && (
              <p className="text-xs text-gray-500 mt-0.5">
                Janela: {data.config.janela_t0 === 'primeiro_export'
                  ? '1º export'
                  : data.config.janela_t0 === 'data_chegada'
                    ? 'Data chegada'
                    : '1º envio'}{' '}
                + 2 dias {data.config.janela_dias_tipo === 'uteis' ? 'úteis' : 'corridos'} ·{' '}
                Gerado em {fmtDateTime(data.generated_at)}
              </p>
            )}
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-3">
          {availableCiclos.length > 1 && (
            <div className="flex items-center gap-2">
              <label htmlFor="ciclo-filter-caa-funnel" className="text-xs text-gray-600 shrink-0">
                Ciclo:
              </label>
              <select
                id="ciclo-filter-caa-funnel"
                value={cicloFilter}
                onChange={(e) => {
                  setCicloFilter(e.target.value);
                  setPage(0);
                }}
                className="text-xs border border-gray-200 rounded-lg px-2 py-1 bg-white text-gray-700 focus:outline-none focus:ring-1 focus:ring-sky-400"
              >
                <option value="all">Todos</option>
                {availableCiclos.map((c) => (
                  <option key={c} value={c}>{c}</option>
                ))}
              </select>
            </div>
          )}
          <button
            type="button"
            onClick={() => void load(estadoFilter, soEngajados, soConflito, cicloFilter, page * LIMIT)}
            disabled={loading}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-gray-700 bg-white border border-gray-200 rounded-md hover:bg-gray-50 disabled:opacity-50"
          >
            <RefreshCw className={`w-3.5 h-3.5 ${loading ? 'animate-spin' : ''}`} />
            Atualizar
          </button>
        </div>
      </header>

      {error && (
        <div className="px-5 py-3 text-sm text-rose-700 bg-rose-50 border-b border-rose-200">
          {error}
        </div>
      )}

      {/* Cards de funil */}
      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-3 p-5 pb-3">
        {ESTADOS_FUNIL.map((estado) => {
          const cfg = ESTADO_CONFIG[estado];
          const count = counts[estado] ?? 0;
          const breakdown = buildCicloBreakdown(estado);
          return (
            <button
              key={estado}
              type="button"
              onClick={() => handleFilterChange(estadoFilter === estado ? 'todos' : estado)}
              className={`rounded-lg border p-3 text-left transition-all ${cfg.card} ${
                estadoFilter === estado ? 'ring-2 ring-offset-1 ring-sky-400' : 'hover:opacity-80'
              }`}
            >
              <div className="text-[11px] font-medium leading-tight">{cfg.label}</div>
              <div className="mt-1 text-2xl font-semibold tabular-nums">{count.toLocaleString('pt-BR')}</div>
              {breakdown && breakdown.length > 0 && (
                <div className="mt-1.5 flex flex-wrap gap-1 text-[10px]">
                  {breakdown.map(({ ciclo, value }) => (
                    <span
                      key={ciclo}
                      className="px-1 py-0.5 rounded bg-white/60 border border-current/30 opacity-90"
                    >
                      {ciclo}: <strong>{value.toLocaleString('pt-BR')}</strong>
                    </span>
                  ))}
                </div>
              )}
            </button>
          );
        })}
      </div>

      {/* Chips de resumo */}
      <div className="px-5 pb-3 flex flex-wrap gap-2 text-xs">
        <span className="px-2.5 py-1 rounded-full border border-gray-200 bg-gray-50 text-gray-700">
          Engajados: <strong>{counts.engajados}</strong>
        </span>
        <span className="px-2.5 py-1 rounded-full border border-amber-200 bg-amber-50 text-amber-800">
          Conflito desfecho × CAA: <strong>{counts.com_conflito}</strong>
        </span>
        {counts.unknown > 0 && (
          <span className="px-2.5 py-1 rounded-full border border-gray-200 bg-gray-50 text-gray-600">
            Unknown: <strong>{counts.unknown}</strong>
          </span>
        )}
      </div>

      {/* Filtros */}
      <div className="px-5 pb-3 border-b border-gray-100 flex flex-wrap gap-1.5">
        <FilterChip
          active={estadoFilter === 'todos'}
          onClick={() => handleFilterChange('todos')}
        >
          Todos
        </FilterChip>
        {ESTADOS_FUNIL.map((estado) => (
          <FilterChip
            key={estado}
            active={estadoFilter === estado}
            onClick={() => handleFilterChange(estadoFilter === estado ? 'todos' : estado)}
          >
            {ESTADO_CONFIG[estado].short}
          </FilterChip>
        ))}
        <div className="w-px bg-gray-200 mx-1 self-stretch" />
        <ToggleChip active={soEngajados} onClick={() => handleFilterChange(undefined, !soEngajados)}>
          Só engajados
        </ToggleChip>
        <ToggleChip active={soConflito} onClick={() => handleFilterChange(undefined, undefined, !soConflito)}>
          Só conflito
        </ToggleChip>
      </div>

      {/* Tabela */}
      <div className="px-5 py-4">
        {loading ? (
          <p className="text-sm text-gray-500 py-6">Carregando…</p>
        ) : !data || data.items.length === 0 ? (
          <p className="text-sm text-gray-500 py-6">
            Nenhum protocolo encontrado com os filtros selecionados.
          </p>
        ) : (
          <>
            <div className="overflow-x-auto rounded-lg border border-gray-100">
              <table className="min-w-full text-sm">
                <thead className="bg-gray-50 text-xs text-gray-600 uppercase tracking-wider">
                  <tr>
                    <th className="px-3 py-2 text-left">Protocolo</th>
                    <th className="px-3 py-2 text-left">Aluno</th>
                    <th className="px-3 py-2 text-left">Polo</th>
                    <th className="px-3 py-2 text-left">Curso</th>
                    <th className="px-3 py-2 text-left">Estado</th>
                    <th className="px-3 py-2 text-left">Janela</th>
                    <th className="px-3 py-2 text-right">Envios (hoje/total)</th>
                    <th className="px-3 py-2 text-left">Última resposta</th>
                    <th className="px-3 py-2 text-left">Desfecho manual</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-100">
                  {data.items.map((item) => (
                    <FunnelRow
                      key={item.protocolo}
                      item={item}
                    />
                  ))}
                </tbody>
              </table>
            </div>

            {/* Paginação */}
            {totalPages > 1 && (
              <div className="flex items-center justify-between mt-3">
                <span className="text-xs text-gray-500">
                  {data.offset + 1}–{Math.min(data.offset + LIMIT, data.total_items)} de{' '}
                  {data.total_items.toLocaleString('pt-BR')}
                </span>
                <div className="flex gap-1">
                  <button
                    type="button"
                    disabled={page === 0}
                    onClick={() => setPage((p) => p - 1)}
                    className="px-3 py-1 text-xs font-medium border border-gray-200 rounded-md disabled:opacity-40 hover:bg-gray-50"
                  >
                    ← Anterior
                  </button>
                  <button
                    type="button"
                    disabled={page >= totalPages - 1}
                    onClick={() => setPage((p) => p + 1)}
                    className="px-3 py-1 text-xs font-medium border border-gray-200 rounded-md disabled:opacity-40 hover:bg-gray-50"
                  >
                    Próximo →
                  </button>
                </div>
              </div>
            )}
          </>
        )}
      </div>

    </section>
  );
}

// ─── Sub-componentes ───────────────────────────────────────────────────────────

function FunnelRow({ item }: { item: CaaFunnelItem }) {
  return (
    <tr className="hover:bg-gray-50">
      <td className="px-3 py-2 font-mono text-xs text-gray-700 whitespace-nowrap">
        {item.protocolo}
      </td>
      <td className="px-3 py-2">
        <div className="text-gray-900 text-xs font-medium">{item.nome || '—'}</div>
        {item.rgm && (
          <div className="text-[11px] text-gray-500 font-mono">{item.rgm}</div>
        )}
      </td>
      <td className="px-3 py-2 text-xs text-gray-600 max-w-[120px] truncate" title={item.polo ?? ''}>
        {item.polo || '—'}
      </td>
      <td className="px-3 py-2 text-xs text-gray-600 max-w-[160px] truncate" title={item.curso ?? ''}>
        {item.curso || '—'}
      </td>
      <td className="px-3 py-2">
        <EstadoBadge estado={item.estado} />
        {item.conflito && (
          <span className="ml-1 inline-block px-1.5 py-0.5 rounded text-[10px] bg-amber-100 text-amber-800 border border-amber-300">
            conflito
          </span>
        )}
      </td>
      <td className="px-3 py-2 whitespace-nowrap">
        <JanelaBadge item={item} />
      </td>
      <td className="px-3 py-2 text-xs text-gray-700 text-right tabular-nums whitespace-nowrap">
        {item.dispatches_today}/{item.dispatches_total}
      </td>
      <td className="px-3 py-2 text-xs text-gray-600 whitespace-nowrap">
        {item.last_response_at ? (
          <span>
            {new Date(item.last_response_at).toLocaleString('pt-BR', {
              day: '2-digit',
              month: '2-digit',
              hour: '2-digit',
              minute: '2-digit',
            })}
            {item.last_response_kind && (
              <span className="ml-1 text-[10px] text-gray-400">({item.last_response_kind})</span>
            )}
          </span>
        ) : (
          <span className="text-gray-400">—</span>
        )}
      </td>
      <td className="px-3 py-2 text-xs">
        {item.manual_outcome ? (
          <span
            className={`inline-block px-2 py-0.5 rounded-full border text-[11px] ${
              item.manual_outcome.outcome === 'revertido'
                ? 'bg-emerald-50 text-emerald-700 border-emerald-200'
                : 'bg-rose-50 text-rose-700 border-rose-200'
            }`}
            title={
              [
                item.manual_outcome.consultor_nome,
                item.manual_outcome.motivo,
              ]
                .filter(Boolean)
                .join(' · ') || undefined
            }
          >
            {OUTCOME_LABEL[item.manual_outcome.outcome] ?? item.manual_outcome.outcome}
          </span>
        ) : (
          <span className="text-gray-400">—</span>
        )}
      </td>
    </tr>
  );
}

function FilterChip({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`px-3 py-1 text-xs font-medium rounded-md border transition ${
        active
          ? 'bg-sky-600 border-sky-600 text-white'
          : 'bg-white border-gray-200 text-gray-700 hover:bg-gray-50'
      }`}
    >
      {children}
    </button>
  );
}

function ToggleChip({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`px-3 py-1 text-xs font-medium rounded-md border transition ${
        active
          ? 'bg-amber-100 border-amber-400 text-amber-900'
          : 'bg-white border-gray-200 text-gray-700 hover:bg-gray-50'
      }`}
    >
      {children}
    </button>
  );
}

// ─── Exportação compacta de counts (para CaaDailyPanel) ───────────────────────

export type { CaaFunnelCounts };
