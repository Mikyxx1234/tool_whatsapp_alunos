import { useCallback, useEffect, useRef, useState } from 'react';
import {
  ChevronDown,
  RefreshCw,
  Send,
  Users,
  MousePointerClick,
  XCircle,
} from 'lucide-react';
import { Header } from '../components/Header';
import {
  reportApi,
  type ActivationConversionResponse,
  type ActivationConversionRecentResponse,
} from '../services/reportApi';

const CATEGORY_OPTIONS: Array<{ value: string; label: string }> = [
  { value: 'all', label: 'Todas as bases' },
  { value: 'processos-caa', label: 'Processos CAA' },
  { value: 'docs-pendentes', label: 'Docs pendentes' },
  { value: 'financeiro', label: 'Financeiro' },
  { value: 'acessos-blackboard', label: 'Sem acesso BB' },
  { value: 'provavel-evasao', label: 'Provável evasão' },
  { value: 'aguardando-inicio', label: 'Aguardando início' },
];

const PERIOD_OPTIONS = [
  { value: 7, label: '7d' },
  { value: 30, label: '30d' },
  { value: 90, label: '90d' },
];

const RESPONSE_KIND_BADGE: Record<string, string> = {
  click: 'bg-blue-50 text-blue-700 border-blue-200',
  message: 'bg-emerald-50 text-emerald-700 border-emerald-200',
  opt_out: 'bg-rose-50 text-rose-700 border-rose-200',
  other: 'bg-gray-50 text-gray-600 border-gray-200',
};

const RESPONSE_KIND_LABEL: Record<string, string> = {
  click: 'Clique',
  message: 'Mensagem',
  opt_out: 'Opt-out',
  other: 'Outro',
};

function fmtPct(r: number): string {
  return (r * 100).toLocaleString('pt-BR', { maximumFractionDigits: 1 }) + '%';
}

function fmtDt(iso: string | null | undefined): string {
  if (!iso) return '—';
  try {
    const d = new Date(iso);
    return d.toLocaleString('pt-BR', {
      day: '2-digit',
      month: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
    });
  } catch {
    return iso;
  }
}

function catLabel(cat: string): string {
  return CATEGORY_OPTIONS.find((o) => o.value === cat)?.label ?? cat;
}

export default function ActivationConversionPage() {
  const [data, setData] = useState<ActivationConversionResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [category, setCategory] = useState('all');
  const [periodDays, setPeriodDays] = useState(30);
  const [recentRows, setRecentRows] = useState<ActivationConversionRecentResponse[]>([]);
  const [loadingMore, setLoadingMore] = useState(false);
  const [popoverOpen, setPopoverOpen] = useState(false);
  const popoverRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!popoverOpen) return;
    function handleClickOutside(e: MouseEvent) {
      if (popoverRef.current && !popoverRef.current.contains(e.target as Node)) {
        setPopoverOpen(false);
      }
    }
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, [popoverOpen]);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const result = await reportApi.activationConversion({
        category,
        period_days: periodDays,
        offset: 0,
      });
      setData(result);
      setRecentRows(result.recent_responses);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Erro ao carregar painel de conversão');
    } finally {
      setLoading(false);
    }
  }, [category, periodDays]);

  useEffect(() => {
    void load();
  }, [load]);

  async function loadMore() {
    if (!data) return;
    setLoadingMore(true);
    try {
      const result = await reportApi.activationConversion({
        category,
        period_days: periodDays,
        offset: recentRows.length,
      });
      setRecentRows((prev) => [...prev, ...result.recent_responses]);
    } catch {
      // silently ignore; user can retry
    } finally {
      setLoadingMore(false);
    }
  }

  const selectedCatLabel =
    CATEGORY_OPTIONS.find((o) => o.value === category)?.label ?? 'Todas as bases';

  return (
    <div className="min-h-screen bg-gray-50">
      <Header />
      <main className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8 space-y-6">

        {/* Page header */}
        <div className="flex flex-wrap items-end justify-between gap-3">
          <div>
            <h2 className="text-xl font-semibold text-gray-900">Conversão de Ativação</h2>
            <p className="text-sm text-gray-500 mt-0.5">
              {data
                ? `Mostrando dados dos últimos ${periodDays} dias para ${selectedCatLabel}.`
                : 'Carregando…'}
            </p>
          </div>
          <button
            type="button"
            onClick={() => void load()}
            disabled={loading}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-gray-700 bg-white border border-gray-200 rounded-md hover:bg-gray-50 disabled:opacity-50"
          >
            <RefreshCw className={`w-3.5 h-3.5 ${loading ? 'animate-spin' : ''}`} />
            Atualizar
          </button>
        </div>

        {/* Filters */}
        <div className="flex flex-wrap items-center gap-2">
          {/* Category popover */}
          <div className="relative" ref={popoverRef}>
            <button
              type="button"
              onClick={() => setPopoverOpen((v) => !v)}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 text-sm font-medium text-gray-700 bg-white border border-gray-200 rounded-lg hover:bg-gray-50 transition-colors"
            >
              Base:{' '}
              <span className="text-gray-900 font-semibold">{selectedCatLabel}</span>
              <ChevronDown
                className={`w-4 h-4 text-gray-500 transition-transform ${popoverOpen ? 'rotate-180' : ''}`}
              />
            </button>
            {popoverOpen && (
              <div className="absolute top-full left-0 mt-1 z-50 bg-white border border-gray-200 rounded-lg shadow-lg p-2 min-w-52 flex flex-col gap-0.5">
                {CATEGORY_OPTIONS.map((opt) => (
                  <button
                    key={opt.value}
                    type="button"
                    onClick={() => {
                      setCategory(opt.value);
                      setPopoverOpen(false);
                    }}
                    className={`text-left px-3 py-1.5 text-sm rounded-md transition-colors ${
                      category === opt.value
                        ? 'bg-whatsapp-50 text-whatsapp-700 font-medium'
                        : 'text-gray-700 hover:bg-gray-50'
                    }`}
                  >
                    {opt.label}
                  </button>
                ))}
              </div>
            )}
          </div>

          {/* Period chips */}
          <div className="flex items-center gap-1 bg-white border border-gray-200 rounded-lg p-1">
            {PERIOD_OPTIONS.map((opt) => (
              <button
                key={opt.value}
                type="button"
                onClick={() => setPeriodDays(opt.value)}
                className={`px-3 py-1 text-xs font-medium rounded-md transition-colors ${
                  periodDays === opt.value
                    ? 'bg-whatsapp-50 text-whatsapp-700 border border-whatsapp-300'
                    : 'text-gray-600 hover:bg-gray-50'
                }`}
              >
                {opt.label}
              </button>
            ))}
          </div>
        </div>

        {error && (
          <div className="p-4 rounded-lg bg-rose-50 border border-rose-200 text-rose-700 text-sm">
            {error}
          </div>
        )}

        {/* KPI cards */}
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
          <KpiCard
            icon={<Send className="w-4 h-4" />}
            tone="sky"
            label="Disparos enviados"
            value={(data?.kpis.total_dispatches ?? 0).toLocaleString('pt-BR')}
            hint={`para ${(data?.kpis.unique_dispatched ?? 0).toLocaleString('pt-BR')} pessoas únicas`}
            loading={loading}
          />
          <KpiCard
            icon={<Users className="w-4 h-4" />}
            tone="emerald"
            label="Responderam"
            value={(data?.kpis.unique_responders ?? 0).toLocaleString('pt-BR')}
            hint={`de ${(data?.kpis.unique_dispatched ?? 0).toLocaleString('pt-BR')} únicos (${fmtPct(data?.kpis.response_rate ?? 0)})`}
            loading={loading}
          />
          <KpiCard
            icon={<MousePointerClick className="w-4 h-4" />}
            tone="blue"
            label="Clicaram em botão"
            value={(data?.kpis.unique_clickers ?? 0).toLocaleString('pt-BR')}
            hint={`de ${(data?.kpis.unique_responders ?? 0).toLocaleString('pt-BR')} que responderam`}
            loading={loading}
          />
          <KpiCard
            icon={<XCircle className="w-4 h-4" />}
            tone="rose"
            label="Opt-out"
            value={(data?.kpis.unique_opt_outs ?? 0).toLocaleString('pt-BR')}
            hint={`${fmtPct(data?.kpis.opt_out_rate ?? 0)} do total enviado`}
            loading={loading}
          />
        </div>

        {/* Category breakdown — only when "all" */}
        {category === 'all' && data && (
          <section className="bg-white rounded-xl border border-gray-100 shadow-sm">
            <div className="px-5 py-4 border-b border-gray-100">
              <h3 className="text-base font-semibold text-gray-900">Quebra por base</h3>
              <p className="text-xs text-gray-500 mt-0.5">
                Clique em uma linha para filtrar os dados por base.
              </p>
            </div>
            <div className="overflow-x-auto">
              <table className="min-w-full text-sm">
                <thead className="bg-gray-50 text-xs text-gray-600 uppercase tracking-wider">
                  <tr>
                    <th className="px-4 py-2 text-left">Base</th>
                    <th className="px-4 py-2 text-right">Enviados</th>
                    <th className="px-4 py-2 text-right">Únicos</th>
                    <th className="px-4 py-2 text-right">Respondidos</th>
                    <th className="px-4 py-2 text-right">Taxa</th>
                    <th className="px-4 py-2 text-right">Opt-out</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-100">
                  {data.by_category.map((row) => (
                    <tr
                      key={row.category}
                      className="hover:bg-gray-50 cursor-pointer"
                      onClick={() => setCategory(row.category)}
                    >
                      <td className="px-4 py-2 font-medium text-gray-900">{row.label}</td>
                      <td className="px-4 py-2 text-right text-gray-700 tabular-nums">
                        {row.total_dispatches.toLocaleString('pt-BR')}
                      </td>
                      <td className="px-4 py-2 text-right text-gray-700 tabular-nums">
                        {row.unique_dispatched.toLocaleString('pt-BR')}
                      </td>
                      <td className="px-4 py-2 text-right text-gray-700 tabular-nums">
                        {row.unique_responders.toLocaleString('pt-BR')}
                      </td>
                      <td className="px-4 py-2 text-right tabular-nums">
                        <span
                          className={`font-medium ${
                            row.response_rate > 0.1
                              ? 'text-emerald-700'
                              : row.response_rate > 0.05
                                ? 'text-amber-700'
                                : 'text-gray-700'
                          }`}
                        >
                          {fmtPct(row.response_rate)}
                        </span>
                      </td>
                      <td className="px-4 py-2 text-right text-gray-700 tabular-nums">
                        {row.unique_opt_outs.toLocaleString('pt-BR')}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>
        )}

        {/* Top buttons */}
        {data && data.top_buttons.length > 0 && (
          <section className="bg-white rounded-xl border border-gray-100 shadow-sm p-5">
            <h3 className="text-base font-semibold text-gray-900 mb-3">Top botões clicados</h3>
            <ol className="space-y-2">
              {data.top_buttons.map((btn, i) => (
                <li key={i} className="flex items-center justify-between gap-3 text-sm">
                  <span className="text-gray-700 min-w-0 truncate">{btn.button_payload}</span>
                  <span className="shrink-0 font-semibold text-gray-900 tabular-nums">
                    {btn.count.toLocaleString('pt-BR')}
                  </span>
                </li>
              ))}
            </ol>
          </section>
        )}

        {/* Recent responses */}
        <section className="bg-white rounded-xl border border-gray-100 shadow-sm">
          <div className="px-5 py-4 border-b border-gray-100 flex items-center justify-between">
            <h3 className="text-base font-semibold text-gray-900">Últimas respostas</h3>
            {data && (
              <span className="text-xs text-gray-500">
                {data.total_recent.toLocaleString('pt-BR')} no período
              </span>
            )}
          </div>

          {loading ? (
            <p className="p-5 text-sm text-gray-500">Carregando…</p>
          ) : recentRows.length === 0 ? (
            <p className="p-5 text-sm text-gray-500">
              Nenhuma resposta registrada no período selecionado.
            </p>
          ) : (
            <>
              <div className="overflow-x-auto">
                <table className="min-w-full text-sm">
                  <thead className="bg-gray-50 text-xs text-gray-600 uppercase tracking-wider">
                    <tr>
                      <th className="px-4 py-2 text-left whitespace-nowrap">Quando</th>
                      <th className="px-4 py-2 text-left">Base</th>
                      <th className="px-4 py-2 text-left">RGM / Nome</th>
                      <th className="px-4 py-2 text-left">Tipo</th>
                      <th className="px-4 py-2 text-left">Botão / Mensagem</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-gray-100">
                    {recentRows.map((row) => (
                      <tr key={row.id} className="hover:bg-gray-50">
                        <td className="px-4 py-2 text-gray-500 text-xs whitespace-nowrap">
                          {fmtDt(row.received_at)}
                        </td>
                        <td className="px-4 py-2 text-gray-600 text-xs whitespace-nowrap">
                          {catLabel(row.category)}
                        </td>
                        <td className="px-4 py-2 text-gray-900">
                          {row.rgm ? (
                            <span className="font-mono text-xs text-gray-800">
                              RGM {row.rgm}
                            </span>
                          ) : (
                            <span className="text-gray-400 text-xs">—</span>
                          )}
                          {row.nome && (
                            <span className="block text-gray-500 text-xs truncate max-w-36">
                              {row.nome}
                            </span>
                          )}
                        </td>
                        <td className="px-4 py-2">
                          <span
                            className={`inline-block px-2 py-0.5 rounded-full text-[11px] border ${
                              RESPONSE_KIND_BADGE[row.response_kind] ??
                              RESPONSE_KIND_BADGE.other
                            }`}
                          >
                            {RESPONSE_KIND_LABEL[row.response_kind] ?? row.response_kind}
                          </span>
                        </td>
                        <td className="px-4 py-2 text-gray-700 text-xs max-w-xs">
                          {row.button_payload
                            ? row.button_payload
                            : row.message_text
                              ? row.message_text.length > 80
                                ? row.message_text.slice(0, 80) + '…'
                                : row.message_text
                              : <span className="text-gray-400">—</span>}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>

              {data && recentRows.length < data.total_recent && (
                <div className="px-5 py-3 border-t border-gray-100">
                  <button
                    type="button"
                    onClick={() => void loadMore()}
                    disabled={loadingMore}
                    className="inline-flex items-center gap-1.5 px-4 py-2 text-sm font-medium text-gray-700 bg-white border border-gray-200 rounded-lg hover:bg-gray-50 disabled:opacity-50"
                  >
                    {loadingMore && <RefreshCw className="w-3.5 h-3.5 animate-spin" />}
                    Carregar mais
                  </button>
                </div>
              )}
            </>
          )}
        </section>
      </main>
    </div>
  );
}

function KpiCard({
  icon,
  tone,
  label,
  value,
  hint,
  loading,
}: {
  icon: React.ReactNode;
  tone: 'sky' | 'emerald' | 'blue' | 'rose';
  label: string;
  value: string;
  hint: string;
  loading: boolean;
}) {
  const toneMap: Record<typeof tone, string> = {
    sky: 'border-sky-200 bg-sky-50 text-sky-800',
    emerald: 'border-emerald-200 bg-emerald-50 text-emerald-800',
    blue: 'border-blue-200 bg-blue-50 text-blue-800',
    rose: 'border-rose-200 bg-rose-50 text-rose-800',
  };
  return (
    <div className={`rounded-lg border p-3 ${toneMap[tone]}`}>
      <div className="flex items-center gap-1.5 text-xs font-medium">
        {icon}
        {label}
      </div>
      <div
        className={`mt-1 text-2xl font-semibold tabular-nums transition-opacity ${
          loading ? 'opacity-40' : ''
        }`}
      >
        {value}
      </div>
      <div className="text-[11px] opacity-80 mt-0.5">{hint}</div>
    </div>
  );
}
