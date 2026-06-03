import { useCallback, useEffect, useState } from 'react';
import { Users, RefreshCw, AlertTriangle, TrendingUp } from 'lucide-react';
import {
  consultorReportApi,
  type ConsultoresReportResponse,
  type ConsultorRow,
} from '../services/consultorReportApi';

const PERIOD_OPTIONS = [7, 30, 90];

function fmtPct(v: number): string {
  if (!Number.isFinite(v) || v <= 0) return '0%';
  return `${(v * 100).toFixed(1)}%`;
}

function pctColor(v: number): string {
  if (v >= 0.5) return 'text-emerald-700';
  if (v >= 0.3) return 'text-amber-700';
  return 'text-slate-600';
}

function fmtRelative(iso: string | null): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  const diff = Date.now() - d.getTime();
  const min = Math.floor(diff / 60000);
  if (min < 60) return `${min}min atrás`;
  const h = Math.floor(min / 60);
  if (h < 24) return `${h}h atrás`;
  const days = Math.floor(h / 24);
  return `${days}d atrás`;
}

export function ConsultoresPanel() {
  const [data, setData] = useState<ConsultoresReportResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [period, setPeriod] = useState(30);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await consultorReportApi.list({ period_days: period });
      setData(res);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Erro ao carregar.');
    } finally {
      setLoading(false);
    }
  }, [period]);

  useEffect(() => {
    void load();
  }, [load]);

  const totals = data?.totals;
  const consultores: ConsultorRow[] = data?.consultores ?? [];

  return (
    <section className="rounded-xl border border-slate-200 bg-white p-5 shadow-sm">
      <header className="flex items-center justify-between mb-4">
        <div>
          <h3 className="text-lg font-semibold text-slate-900 flex items-center gap-2">
            <Users className="h-5 w-5 text-indigo-600" />
            Por consultor — CAA
          </h3>
          <p className="text-xs text-slate-500 mt-1">
            Atribuído pelo campo "consultor responsável" do DataCrazy no momento do
            desfecho. Operadores que clicam em "Ativar" não aparecem aqui.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <div className="inline-flex rounded-lg border border-slate-200 bg-slate-50 p-0.5">
            {PERIOD_OPTIONS.map((d) => (
              <button
                key={d}
                type="button"
                onClick={() => setPeriod(d)}
                className={`px-3 py-1 text-xs font-medium rounded-md transition ${
                  period === d
                    ? 'bg-white text-slate-900 shadow-sm'
                    : 'text-slate-600 hover:text-slate-900'
                }`}
              >
                {d}d
              </button>
            ))}
          </div>
          <button
            type="button"
            onClick={() => void load()}
            disabled={loading}
            className="inline-flex items-center gap-1 rounded-lg border border-slate-200 bg-white px-3 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-50"
          >
            <RefreshCw className={`h-3.5 w-3.5 ${loading ? 'animate-spin' : ''}`} />
            Atualizar
          </button>
        </div>
      </header>

      {error && (
        <div className="mb-4 flex items-start gap-2 rounded-lg border border-rose-200 bg-rose-50 p-3 text-sm text-rose-700">
          <AlertTriangle className="h-4 w-4 mt-0.5" />
          <div>{error}</div>
        </div>
      )}

      {totals && (
        <div className="grid grid-cols-3 gap-3 mb-4">
          <div className="rounded-lg border border-slate-200 bg-slate-50 p-3">
            <div className="text-[11px] uppercase tracking-wider text-slate-500">
              Revertidos
            </div>
            <div className="text-2xl font-semibold text-emerald-700 mt-1">
              {totals.caa_revertidos}
            </div>
          </div>
          <div className="rounded-lg border border-slate-200 bg-slate-50 p-3">
            <div className="text-[11px] uppercase tracking-wider text-slate-500">
              Perdidos
            </div>
            <div className="text-2xl font-semibold text-rose-700 mt-1">
              {totals.caa_perdidos}
            </div>
          </div>
          <div className="rounded-lg border border-slate-200 bg-slate-50 p-3">
            <div className="text-[11px] uppercase tracking-wider text-slate-500">
              Respostas atribuídas
            </div>
            <div className="text-2xl font-semibold text-slate-900 mt-1">
              {totals.total_respostas}
            </div>
          </div>
        </div>
      )}

      {loading && !data && (
        <div className="py-8 text-center text-sm text-slate-500">Carregando…</div>
      )}

      {!loading && consultores.length === 0 && (
        <div className="rounded-lg border border-dashed border-slate-300 bg-slate-50 p-6 text-center">
          <TrendingUp className="h-6 w-6 text-slate-400 mx-auto mb-2" />
          <div className="text-sm text-slate-600">
            Nenhum consultor com atividade no período.
          </div>
          <div className="text-xs text-slate-500 mt-2 max-w-md mx-auto">
            Os dados começam a aparecer aqui assim que o webhook do n8n incluir o
            campo <code className="text-[11px] bg-slate-200 rounded px-1">consultor_responsavel_nome</code>{' '}
            e/ou o sync de desfecho CAA detectar o consultor que fechou o lead.
          </div>
        </div>
      )}

      {consultores.length > 0 && (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-slate-200 text-left text-xs font-medium uppercase tracking-wider text-slate-500">
                <th className="px-2 py-2">Consultor</th>
                <th className="px-2 py-2 text-right">Revertidos</th>
                <th className="px-2 py-2 text-right">Perdidos</th>
                <th className="px-2 py-2 text-right">Taxa</th>
                <th className="px-2 py-2 text-right">Respostas</th>
                <th className="px-2 py-2 text-right">Última atividade</th>
              </tr>
            </thead>
            <tbody>
              {consultores.map((c) => (
                <tr
                  key={c.consultor_nome ?? '—'}
                  className="border-b border-slate-100 hover:bg-slate-50"
                >
                  <td className="px-2 py-2 font-medium text-slate-900">
                    {c.consultor_nome ?? <span className="text-slate-400">Sem nome</span>}
                  </td>
                  <td className="px-2 py-2 text-right text-emerald-700 tabular-nums">
                    {c.caa_revertidos}
                  </td>
                  <td className="px-2 py-2 text-right text-rose-700 tabular-nums">
                    {c.caa_perdidos}
                  </td>
                  <td
                    className={`px-2 py-2 text-right tabular-nums font-medium ${pctColor(
                      c.caa_taxa_reversao
                    )}`}
                  >
                    {fmtPct(c.caa_taxa_reversao)}
                  </td>
                  <td className="px-2 py-2 text-right text-slate-700 tabular-nums">
                    {c.total_respostas}
                  </td>
                  <td className="px-2 py-2 text-right text-xs text-slate-500">
                    {fmtRelative(c.ultima_atribuicao)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
