import { useCallback, useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  Activity,
  ArrowDownRight,
  ArrowUpRight,
  Minus,
  RefreshCw,
  TrendingUp,
  Users,
  Wallet,
  GraduationCap,
} from 'lucide-react';
import { reportApi, type RematriculaTrackingResponse } from '../services/reportApi';

function fmt(n: number | null | undefined) {
  return (n ?? 0).toLocaleString('pt-BR');
}

function fmtPct(n: number | null | undefined) {
  if (n == null || Number.isNaN(n)) return '—';
  return `${Number(n).toFixed(1).replace('.', ',')}%`;
}

function fmtDt(iso: string | null | undefined) {
  if (!iso) return '—';
  return new Date(iso).toLocaleString('pt-BR', {
    day: '2-digit',
    month: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });
}

function fmtDay(d: string) {
  const dt = new Date(`${String(d).slice(0, 10)}T12:00:00`);
  return dt.toLocaleDateString('pt-BR', { day: '2-digit', month: 'short' });
}

function DeltaBadge({ value }: { value: number | null | undefined }) {
  if (value == null || value === 0) {
    return (
      <span className="inline-flex items-center gap-0.5 text-[10px] font-medium text-slate-400">
        <Minus className="w-3 h-3" /> 0 vs ontem
      </span>
    );
  }
  const up = value > 0;
  const bad = up;
  return (
    <span
      className={`inline-flex items-center gap-0.5 text-[10px] font-semibold tabular-nums ${
        bad ? 'text-rose-400' : 'text-emerald-400'
      }`}
    >
      {up ? <ArrowUpRight className="w-3 h-3" /> : <ArrowDownRight className="w-3 h-3" />}
      {up ? '+' : ''}
      {fmt(value)} vs ontem
    </span>
  );
}

function sourceLabel(source: string | null | undefined) {
  if (source === 'siaa') return 'SIAA';
  if (source === 'portal-de-polos') return 'Portal de Polos';
  return '—';
}

function pctVar(current: number, previous: number | null | undefined): number | null {
  if (previous == null || previous === 0) return null;
  return ((current - previous) / previous) * 100;
}

/** Variação % vs dia anterior — invertColors: subir = ruim (inadimplente). */
function PctVarCell({
  value,
  invertColors = false,
}: {
  value: number | null;
  invertColors?: boolean;
}) {
  if (value == null) return <span className="text-slate-500">—</span>;
  if (Math.abs(value) < 0.05) {
    return <span className="text-slate-500 tabular-nums">0%</span>;
  }
  const up = value > 0;
  const good = invertColors ? !up : up;
  return (
    <span className={`tabular-nums font-medium ${good ? 'text-emerald-400' : 'text-rose-400'}`}>
      {up ? '+' : ''}
      {value.toFixed(1).replace('.', ',')}%
    </span>
  );
}

function buildPrevByDate<T extends { stat_date: string }>(series: T[]): Map<string, T | null> {
  const sorted = [...series].sort((a, b) => String(a.stat_date).localeCompare(String(b.stat_date)));
  const map = new Map<string, T | null>();
  sorted.forEach((row, i) => {
    map.set(String(row.stat_date).slice(0, 10), i > 0 ? sorted[i - 1] : null);
  });
  return map;
}

export function RematriculaTrackingPanel() {
  const [data, setData] = useState<RematriculaTrackingResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [days, setDays] = useState(30);
  const [focusDate, setFocusDate] = useState('');
  const [rangeFrom, setRangeFrom] = useState('');
  const [rangeTo, setRangeTo] = useState('');

  const fetchTracking = useCallback(
    async (
      capture = false,
      overrides: Partial<{ date: string; from: string; to: string; days: number }> = {}
    ) => {
      setLoading(true);
      setError(null);
      try {
        const fd = overrides.date !== undefined ? overrides.date : focusDate;
        const rf = overrides.from !== undefined ? overrides.from : rangeFrom;
        const rt = overrides.to !== undefined ? overrides.to : rangeTo;
        const d = overrides.days !== undefined ? overrides.days : days;

        const opts: Parameters<typeof reportApi.rematriculaTracking>[0] = { capture };
        if (rf && rt) {
          opts.from = rf;
          opts.to = rt;
        } else {
          opts.days = d;
        }
        if (fd) opts.date = fd;

        const r = await reportApi.rematriculaTracking(opts);
        setData(r);
      } catch (e) {
        setError(e instanceof Error ? e.message : 'Erro ao carregar painel');
        setData(null);
      } finally {
        setLoading(false);
      }
    },
    [days, focusDate, rangeFrom, rangeTo]
  );

  const load = useCallback((capture = false) => fetchTracking(capture), [fetchTracking]);
  const didMountRef = useRef(false);

  useEffect(() => {
    void fetchTracking(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (!didMountRef.current) {
      didMountRef.current = true;
      return;
    }
    if (rangeFrom || rangeTo || focusDate) return;
    void fetchTracking(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [days]);

  const series = data?.series ?? [];
  const prevByDate = buildPrevByDate(series);
  const k = data?.kpis;
  const viewingDate = data?.focus_date || null;
  const dateFound = data?.focus_found;
  const hasCustomRange = Boolean(data?.filter?.from && data?.filter?.to);

  const applyFocusDate = () => {
    void fetchTracking(false, { date: focusDate });
  };

  const clearFocus = () => {
    setFocusDate('');
    void fetchTracking(false, { date: '' });
  };

  const applyRange = () => {
    if (rangeFrom && rangeTo) void fetchTracking(false);
  };

  const clearRange = () => {
    setRangeFrom('');
    setRangeTo('');
    void fetchTracking(false, { from: '', to: '' });
  };

  return (
    <div className="space-y-6">
      <header className="flex flex-col md:flex-row md:items-end justify-between gap-4">
        <div>
          <h2 className="text-xl font-bold text-slate-100 flex items-center gap-2">
            <Activity className="w-5 h-5 text-sky-400" />
            Acompanhamento Rematrícula
          </h2>
          <p className="text-sm text-slate-400 mt-1 max-w-2xl">
            Evolução diária da base SIAA/Portal — <strong className="text-slate-300">EM CURSO</strong> ·
            adimplente vs inadimplente. Upload em{' '}
            <Link to="/bases" className="text-sky-400 hover:underline">
              Bases → Rematrícula
            </Link>
            .
          </p>
        </div>
        <div className="flex flex-col gap-2 w-full md:w-auto md:min-w-[28rem]">
          <div className="flex flex-wrap items-center gap-2">
            <label className="text-[10px] font-bold uppercase tracking-wider text-slate-500 shrink-0">
              Data
            </label>
            <input
              type="date"
              value={focusDate}
              onChange={(e) => setFocusDate(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && applyFocusDate()}
              className="text-xs bg-slate-800 border border-slate-600 text-slate-200 rounded-lg px-2 py-1.5 [color-scheme:dark]"
              title="Filtrar KPIs por dia"
            />
            <button
              type="button"
              disabled={loading || !focusDate}
              onClick={() => applyFocusDate()}
              className="text-xs px-2.5 py-1.5 rounded-lg bg-sky-700/80 text-white hover:bg-sky-600 disabled:opacity-40"
            >
              Buscar
            </button>
            {focusDate && (
              <button
                type="button"
                onClick={() => clearFocus()}
                className="text-[10px] px-2 py-1 rounded-lg border border-emerald-700/50 text-emerald-300 hover:bg-emerald-950/50"
              >
                Ao vivo
              </button>
            )}
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <label className="text-[10px] font-bold uppercase tracking-wider text-slate-500 shrink-0">
              Período
            </label>
            <input
              type="date"
              value={rangeFrom}
              onChange={(e) => setRangeFrom(e.target.value)}
              className="text-xs bg-slate-800 border border-slate-600 text-slate-200 rounded-lg px-2 py-1.5 [color-scheme:dark]"
              title="De"
            />
            <span className="text-slate-600 text-xs">→</span>
            <input
              type="date"
              value={rangeTo}
              onChange={(e) => setRangeTo(e.target.value)}
              className="text-xs bg-slate-800 border border-slate-600 text-slate-200 rounded-lg px-2 py-1.5 [color-scheme:dark]"
              title="Até"
            />
            <button
              type="button"
              disabled={loading || !rangeFrom || !rangeTo}
              onClick={() => applyRange()}
              className="text-xs px-2.5 py-1.5 rounded-lg border border-slate-600 text-slate-200 hover:bg-slate-700 disabled:opacity-40"
            >
              Aplicar
            </button>
            {(rangeFrom || rangeTo) && (
              <button
                type="button"
                onClick={() => clearRange()}
                className="text-[10px] text-slate-500 hover:text-slate-300"
              >
                Limpar
              </button>
            )}
            {!rangeFrom && !rangeTo && (
              <select
                value={days}
                onChange={(e) => setDays(Number(e.target.value))}
                className="text-xs bg-slate-800 border border-slate-600 text-slate-200 rounded-lg px-2 py-1.5"
                title="Atalho: últimos N dias"
              >
                <option value={14}>14 dias</option>
                <option value={30}>30 dias</option>
                <option value={60}>60 dias</option>
                <option value={90}>90 dias</option>
                <option value={180}>180 dias</option>
                <option value={365}>365 dias</option>
              </select>
            )}
            <span className="text-[10px] text-slate-500 font-mono ml-auto">
              {data?.generated_at ? fmtDt(data.generated_at) : '—'}
            </span>
            <button
              type="button"
              disabled={loading}
              onClick={() => void load(true)}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-slate-200 bg-slate-800 border border-slate-600 rounded-lg hover:bg-slate-700 disabled:opacity-50"
            >
              <RefreshCw className={`w-3.5 h-3.5 ${loading ? 'animate-spin' : ''}`} />
              Atualizar
            </button>
          </div>
        </div>
      </header>

      {viewingDate && (
        <p className="text-xs text-sky-300/90 bg-sky-950/40 border border-sky-800/50 rounded-lg px-3 py-2">
          KPIs em <strong>{fmtDay(viewingDate)}</strong>
          {dateFound === false ? ' — sem captura registrada neste dia' : ''}
        </p>
      )}

      {data?.filter?.from && data?.filter?.to && (
        <p className="text-xs text-slate-400 bg-slate-900/60 border border-slate-700 rounded-lg px-3 py-2">
          Período analisado: {data.filter.from} → {data.filter.to}
        </p>
      )}

      {data?.snapshot && (
        <p className="text-xs text-emerald-400/90 bg-emerald-950/40 border border-emerald-800/50 rounded-lg px-3 py-2 inline-flex flex-wrap gap-x-2">
          <span>
            Base: <strong>{sourceLabel(data.snapshot.source)}</strong>
          </span>
          <span>·</span>
          <span>{data.snapshot.file_name}</span>
          <span>·</span>
          <span>{fmt(data.snapshot.row_count)} linhas no arquivo</span>
          <span>·</span>
          <span>{fmtDt(data.snapshot.created_at)}</span>
        </p>
      )}

      {error && (
        <div className="text-sm text-rose-300 bg-rose-950/50 border border-rose-800 rounded-lg px-3 py-2">
          {error}
        </div>
      )}

      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        <div className="rounded-2xl border border-sky-500/30 bg-gradient-to-br from-sky-950/80 to-slate-900 p-4">
          <div className="flex items-center gap-2 text-sky-300/80 text-[10px] font-bold uppercase tracking-wider">
            <Users className="w-3.5 h-3.5" /> EM CURSO
          </div>
          <p className="text-3xl font-bold text-white tabular-nums mt-2">{loading ? '…' : fmt(k?.total_em_curso)}</p>
          <DeltaBadge value={k?.delta_total} />
        </div>

        <div className="rounded-2xl border border-rose-500/30 bg-slate-900/80 p-4">
          <div className="flex items-center gap-2 text-rose-300/80 text-[10px] font-bold uppercase tracking-wider">
            <TrendingUp className="w-3.5 h-3.5" /> Inadimplente
          </div>
          <p className="text-3xl font-bold text-rose-200 tabular-nums mt-2">
            {loading ? '…' : fmt(k?.inadimplente)}
          </p>
          <p className="text-xs text-rose-300/70 mt-0.5">{fmtPct(k?.pct_inadimplente)} do total</p>
          <DeltaBadge value={k?.delta_inadimplente} />
        </div>

        <div className="rounded-2xl border border-emerald-500/30 bg-slate-900/80 p-4">
          <div className="flex items-center gap-2 text-emerald-300/80 text-[10px] font-bold uppercase tracking-wider">
            <Wallet className="w-3.5 h-3.5" /> Adimplente
          </div>
          <p className="text-3xl font-bold text-emerald-200 tabular-nums mt-2">
            {loading ? '…' : fmt(k?.adimplente)}
          </p>
          <DeltaBadge value={k?.delta_adimplente} />
        </div>

        <div className="rounded-2xl border border-violet-500/30 bg-slate-900/80 p-4">
          <div className="flex items-center gap-2 text-violet-300/80 text-[10px] font-bold uppercase tracking-wider">
            <GraduationCap className="w-3.5 h-3.5" /> Rematrículas
          </div>
          <p className="text-3xl font-bold text-violet-200 tabular-nums mt-2">
            {loading ? '…' : fmt(k?.rematriculas_acumuladas)}
          </p>
          <p className="text-xs text-slate-500 mt-0.5">
            matriculados (upload CRM) · ciclo {k?.rematriculas_ciclo || '—'} · {fmt(k?.rematriculas_hoje)}{' '}
            {viewingDate ? 'no dia' : 'hoje'} · {fmt(k?.rematriculas_periodo)} no período
          </p>
        </div>
      </div>

      {series.length > 0 && (
        <div className="rounded-2xl border border-slate-700/80 bg-slate-900/60 overflow-hidden">
          <h3 className="text-sm font-semibold text-slate-200 px-4 py-3 border-b border-slate-700/80">
            Histórico ({series.length} dias)
          </h3>
          <div className="overflow-x-auto">
            <table className="min-w-full text-xs">
              <thead className="bg-slate-800/80 text-slate-400">
                <tr>
                  <th className="px-3 py-2 text-left font-medium">Data</th>
                  <th className="px-3 py-2 text-right font-medium">Total</th>
                  <th className="px-3 py-2 text-right font-medium">Var.</th>
                  <th className="px-3 py-2 text-right font-medium">Inad.</th>
                  <th className="px-3 py-2 text-right font-medium">Var.</th>
                  <th className="px-3 py-2 text-right font-medium">Adimpl.</th>
                  <th className="px-3 py-2 text-right font-medium">Var.</th>
                  <th className="px-3 py-2 text-right font-medium">Ativações</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-800">
                {[...series].reverse().slice(0, hasCustomRange ? series.length : 14).map((row) => {
                  const prev = prevByDate.get(String(row.stat_date).slice(0, 10)) ?? null;

                  return (
                  <tr key={row.stat_date} className="hover:bg-slate-800/40">
                    <td className="px-3 py-2 text-slate-300">{fmtDay(row.stat_date)}</td>
                    <td className="px-3 py-2 text-right tabular-nums text-slate-200">{fmt(row.total_em_curso)}</td>
                    <td className="px-3 py-2 text-right">
                      <PctVarCell value={pctVar(row.total_em_curso, prev?.total_em_curso)} />
                    </td>
                    <td className="px-3 py-2 text-right tabular-nums text-rose-300">{fmt(row.inadimplente)}</td>
                    <td className="px-3 py-2 text-right">
                      <PctVarCell
                        value={pctVar(row.inadimplente, prev?.inadimplente)}
                        invertColors
                      />
                    </td>
                    <td className="px-3 py-2 text-right tabular-nums text-emerald-300">{fmt(row.adimplente)}</td>
                    <td className="px-3 py-2 text-right">
                      <PctVarCell value={pctVar(row.adimplente, prev?.adimplente)} />
                    </td>
                    <td className="px-3 py-2 text-right tabular-nums text-violet-300">{fmt(row.ativacoes_dia)}</td>
                  </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}
