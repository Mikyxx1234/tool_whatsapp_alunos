import { useEffect, useState } from 'react';
import { Loader2, Users, RotateCw, ChevronRight, AlertCircle } from 'lucide-react';
import {
  consultorReportApi,
  type ConsultoresReportResponse,
  type ConsultorRow,
} from '../services/consultorReportApi';

const PERIOD_CHIPS = [
  { id: 7, label: '7d' },
  { id: 30, label: '30d' },
  { id: 90, label: '90d' },
];

const CATEGORY_OPTIONS: { id: string; label: string }[] = [
  { id: 'all', label: 'Todas as bases' },
  { id: 'processos-caa', label: 'CAA cancelamento' },
  { id: 'docs-pendentes', label: 'Docs pendentes' },
  { id: 'financeiro', label: 'Inadimplentes' },
  { id: 'provavel-evasao', label: 'Provável evasão' },
  { id: 'acessos-blackboard', label: 'Sem acesso BB' },
  { id: 'aguardando-inicio', label: 'Aguardando início' },
];

function fmt(n: number) {
  return n.toLocaleString('pt-BR');
}

function pct(n: number) {
  if (!n) return '0%';
  return `${n.toFixed(1).replace('.', ',')}%`;
}

function rateColor(rate: number) {
  if (rate >= 30) return 'text-emerald-700';
  if (rate >= 10) return 'text-amber-700';
  return 'text-gray-600';
}

function reversalColor(rate: number) {
  if (rate >= 50) return 'text-emerald-700';
  if (rate >= 25) return 'text-amber-700';
  return 'text-gray-600';
}

export function ConsultoresPanel() {
  const [data, setData] = useState<ConsultoresReportResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [period, setPeriod] = useState<number>(30);
  const [category, setCategory] = useState<string>('all');
  const [expanded, setExpanded] = useState<string | null>(null);

  const load = async () => {
    setLoading(true);
    setError(null);
    try {
      const r = await consultorReportApi.list({
        periodDays: period,
        category,
        attributionWindowDays: 14,
      });
      setData(r);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Erro ao carregar consultores');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [period, category]);

  const isCaaScope = category === 'all' || category === 'processos-caa';

  return (
    <div className="bg-white rounded-2xl border border-gray-100 shadow-sm p-4 sm:p-6">
      <div className="flex flex-wrap items-center justify-between gap-3 mb-4">
        <div className="flex items-center gap-2">
          <Users className="w-5 h-5 text-whatsapp-700" />
          <h2 className="text-base font-semibold text-gray-900">Por consultor</h2>
        </div>
        <div className="flex flex-wrap items-center gap-3">
          <div className="flex items-center gap-1">
            <span className="text-xs text-gray-600 mr-1">Base:</span>
            <select
              value={category}
              onChange={(e) => setCategory(e.target.value)}
              className="text-xs border border-gray-200 rounded-lg px-2 py-1 bg-white"
            >
              {CATEGORY_OPTIONS.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.label}
                </option>
              ))}
            </select>
          </div>
          <div className="flex items-center gap-1 bg-gray-50 rounded-lg p-0.5">
            {PERIOD_CHIPS.map((p) => (
              <button
                key={p.id}
                type="button"
                onClick={() => setPeriod(p.id)}
                className={`px-2.5 py-1 text-xs font-medium rounded-md transition-colors ${
                  period === p.id
                    ? 'bg-white shadow-sm text-whatsapp-800'
                    : 'text-gray-600 hover:text-gray-900'
                }`}
              >
                {p.label}
              </button>
            ))}
          </div>
          <button
            type="button"
            onClick={() => void load()}
            disabled={loading}
            className="inline-flex items-center gap-1 text-xs text-whatsapp-700 hover:underline disabled:opacity-50"
          >
            {loading ? <Loader2 className="w-3 h-3 animate-spin" /> : <RotateCw className="w-3 h-3" />}
            Atualizar
          </button>
        </div>
      </div>

      <p className="text-xs text-gray-500 mb-4 leading-relaxed">
        Disparos por consultor nos últimos {period} dias. <strong>Revertidos</strong> e{' '}
        <strong>Perdidos</strong> CAA são atribuídos ao último consultor que disparou pro RGM
        dentro de 14 dias antes do desfecho mudar no CAA. "Sem consultor" = disparos
        antigos ou automáticos.
      </p>

      {error && (
        <div className="mb-3 flex items-start gap-2 text-xs text-rose-700 bg-rose-50 border border-rose-100 rounded-lg px-3 py-2">
          <AlertCircle className="w-3.5 h-3.5 mt-0.5 shrink-0" />
          <span>{error}</span>
        </div>
      )}

      {loading && !data && (
        <div className="py-8 text-center text-sm text-gray-500">
          <Loader2 className="w-5 h-5 animate-spin inline-block mr-2" />
          Carregando…
        </div>
      )}

      {data && data.consultores.length === 0 && (
        <div className="py-8 text-center text-sm text-gray-500">
          Nenhum disparo no período.
        </div>
      )}

      {data && data.consultores.length > 0 && (
        <div className="overflow-x-auto -mx-2">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-[10px] text-gray-500 uppercase tracking-wider border-b border-gray-100">
                <th className="text-left font-medium px-2 py-2">Consultor</th>
                <th className="text-right font-medium px-2 py-2">Enviados</th>
                <th className="text-right font-medium px-2 py-2">Únicas</th>
                <th className="text-right font-medium px-2 py-2">Resp.</th>
                <th className="text-right font-medium px-2 py-2">Taxa resp.</th>
                {isCaaScope && (
                  <>
                    <th className="text-right font-medium px-2 py-2">Rev. CAA</th>
                    <th className="text-right font-medium px-2 py-2">Perd. CAA</th>
                    <th className="text-right font-medium px-2 py-2">Tx. reversão</th>
                  </>
                )}
                <th className="w-6" />
              </tr>
            </thead>
            <tbody>
              {data.consultores.map((c) => (
                <ConsultorRowDisplay
                  key={c.key}
                  c={c}
                  isCaaScope={isCaaScope}
                  expanded={expanded === c.key}
                  onToggle={() => setExpanded(expanded === c.key ? null : c.key)}
                />
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function ConsultorRowDisplay({
  c,
  isCaaScope,
  expanded,
  onToggle,
}: {
  c: ConsultorRow;
  isCaaScope: boolean;
  expanded: boolean;
  onToggle: () => void;
}) {
  const t = c.totals;
  const isSemConsultor = c.key === '__sem_consultor__';
  return (
    <>
      <tr
        className={`border-b border-gray-50 hover:bg-gray-50/60 cursor-pointer ${
          isSemConsultor ? 'text-gray-500 italic' : 'text-gray-800'
        }`}
        onClick={onToggle}
      >
        <td className="px-2 py-2">
          <div className="flex items-center gap-1.5">
            <ChevronRight
              className={`w-3 h-3 text-gray-400 transition-transform ${expanded ? 'rotate-90' : ''}`}
            />
            <span className="font-medium">{c.label}</span>
            {c.consultor_id != null && (
              <span className="text-[10px] text-gray-400">#{c.consultor_id}</span>
            )}
          </div>
        </td>
        <td className="px-2 py-2 text-right tabular-nums font-semibold">{fmt(t.dispatches_sent)}</td>
        <td className="px-2 py-2 text-right tabular-nums">{fmt(t.unique_recipients)}</td>
        <td className="px-2 py-2 text-right tabular-nums">{fmt(t.unique_responders)}</td>
        <td className={`px-2 py-2 text-right tabular-nums font-medium ${rateColor(t.response_rate)}`}>
          {pct(t.response_rate)}
        </td>
        {isCaaScope && (
          <>
            <td className="px-2 py-2 text-right tabular-nums text-emerald-700 font-medium">
              {fmt(t.caa_revertidos)}
            </td>
            <td className="px-2 py-2 text-right tabular-nums text-rose-700">
              {fmt(t.caa_perdidos)}
            </td>
            <td
              className={`px-2 py-2 text-right tabular-nums font-medium ${reversalColor(t.caa_taxa_reversao)}`}
            >
              {pct(t.caa_taxa_reversao)}
            </td>
          </>
        )}
        <td />
      </tr>
      {expanded && (
        <tr className="bg-gray-50/40">
          <td colSpan={isCaaScope ? 9 : 6} className="px-4 py-3">
            <CategoryBreakdown row={c} />
          </td>
        </tr>
      )}
    </>
  );
}

function CategoryBreakdown({ row }: { row: ConsultorRow }) {
  const entries = Object.entries(row.by_category).filter(
    ([, s]) => s.dispatches_sent > 0 || s.unique_responders > 0 || s.caa_revertidos > 0 || s.caa_perdidos > 0
  );
  if (entries.length === 0) {
    return <div className="text-xs text-gray-500 italic">Sem atividade por categoria.</div>;
  }
  return (
    <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-2">
      {entries.map(([cat, s]) => {
        const meta = CATEGORY_OPTIONS.find((c) => c.id === cat);
        const isCaa = cat === 'processos-caa';
        return (
          <div
            key={cat}
            className="bg-white border border-gray-100 rounded-lg px-3 py-2 text-xs"
          >
            <div className="font-medium text-gray-700 mb-1">{meta?.label ?? cat}</div>
            <div className="grid grid-cols-2 gap-x-3 gap-y-0.5 text-gray-600">
              <span>Enviados</span>
              <span className="text-right tabular-nums">{fmt(s.dispatches_sent)}</span>
              <span>Respondem</span>
              <span className="text-right tabular-nums">{fmt(s.unique_responders)}</span>
              <span>Taxa</span>
              <span className={`text-right tabular-nums ${rateColor(s.response_rate)}`}>
                {pct(s.response_rate)}
              </span>
              {isCaa && (
                <>
                  <span>Revertidos</span>
                  <span className="text-right tabular-nums text-emerald-700">{fmt(s.caa_revertidos)}</span>
                  <span>Perdidos</span>
                  <span className="text-right tabular-nums text-rose-700">{fmt(s.caa_perdidos)}</span>
                  <span>Tx. reversão</span>
                  <span className={`text-right tabular-nums ${reversalColor(s.caa_taxa_reversao)}`}>
                    {pct(s.caa_taxa_reversao)}
                  </span>
                </>
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}
