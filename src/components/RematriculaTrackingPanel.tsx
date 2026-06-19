import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  Activity,
  ArrowDownRight,
  ArrowUpRight,
  Minus,
  RefreshCw,
  TrendingDown,
  TrendingUp,
  Users,
  Wallet,
  Zap,
} from 'lucide-react';
import { reportApi, type RematriculaDailyStat, type RematriculaTrackingResponse } from '../services/reportApi';

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

function EvolutionChart({ series }: { series: RematriculaDailyStat[] }) {
  const { paths, labels, w, h } = useMemo(() => {
    const width = 640;
    const height = 200;
    const pad = { t: 12, r: 12, b: 28, l: 40 };
    if (!series.length) return { paths: null, labels: [], w: width, h: height };

    const innerW = width - pad.l - pad.r;
    const innerH = height - pad.t - pad.b;
    const maxY = Math.max(...series.map((s) => s.total_em_curso), 1);

    const xAt = (i: number) => pad.l + (i / Math.max(series.length - 1, 1)) * innerW;
    const yAt = (v: number) => pad.t + innerH - (v / maxY) * innerH;

    const line = (key: 'total_em_curso' | 'inadimplente' | 'adimplente', color: string) => {
      const pts = series.map((s, i) => `${xAt(i)},${yAt(s[key])}`).join(' ');
      return { d: `M ${pts.replace(/ /g, ' L ')}`, color };
    };

    const lbl =
      series.length <= 8
        ? series.map((s, i) => ({ x: xAt(i), text: fmtDay(s.stat_date) }))
        : series
            .filter((_, i) => i === 0 || i === series.length - 1 || i % Math.ceil(series.length / 6) === 0)
            .map((s) => {
              const i = series.indexOf(s);
              return { x: xAt(i), text: fmtDay(s.stat_date) };
            });

    return {
      paths: {
        total: line('total_em_curso', '#38bdf8'),
        inad: line('inadimplente', '#fb7185'),
        adimpl: line('adimplente', '#34d399'),
      },
      labels: lbl,
      w: width,
      h: height,
    };
  }, [series]);

  if (!paths) {
    return (
      <p className="text-sm text-slate-500 py-12 text-center">
        Ainda sem histórico diário — volte amanhã ou suba um novo export SIAA.
      </p>
    );
  }

  return (
    <div className="w-full overflow-x-auto">
      <svg viewBox={`0 0 ${w} ${h}`} className="w-full min-w-[320px] h-auto" role="img" aria-label="Evolução diária">
        {labels.map((l) => (
          <text
            key={l.text + l.x}
            x={l.x}
            y={h - 6}
            textAnchor="middle"
            className="fill-slate-500 text-[9px]"
          >
            {l.text}
          </text>
        ))}
        <path d={paths.adimpl.d} fill="none" stroke={paths.adimpl.color} strokeWidth="2" opacity="0.9" />
        <path d={paths.inad.d} fill="none" stroke={paths.inad.color} strokeWidth="2.5" opacity="0.95" />
        <path d={paths.total.d} fill="none" stroke={paths.total.color} strokeWidth="2" strokeDasharray="4 3" opacity="0.7" />
      </svg>
      <div className="flex flex-wrap gap-4 mt-2 text-[10px] text-slate-400">
        <span className="flex items-center gap-1.5">
          <span className="w-3 h-0.5 bg-sky-400 inline-block" /> Total EM CURSO
        </span>
        <span className="flex items-center gap-1.5">
          <span className="w-3 h-0.5 bg-rose-400 inline-block" /> Inadimplente
        </span>
        <span className="flex items-center gap-1.5">
          <span className="w-3 h-0.5 bg-emerald-400 inline-block" /> Adimplente
        </span>
      </div>
    </div>
  );
}

function sourceLabel(source: string | null | undefined) {
  if (source === 'siaa') return 'SIAA';
  if (source === 'portal-de-polos') return 'Portal de Polos';
  return '—';
}

export function RematriculaTrackingPanel() {
  const [data, setData] = useState<RematriculaTrackingResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [days, setDays] = useState(30);

  const load = useCallback(
    async (capture = false) => {
      setLoading(true);
      setError(null);
      try {
        const r = await reportApi.rematriculaTracking({ days, capture });
        setData(r);
      } catch (e) {
        setError(e instanceof Error ? e.message : 'Erro ao carregar painel');
        setData(null);
      } finally {
        setLoading(false);
      }
    },
    [days]
  );

  useEffect(() => {
    void load(true);
  }, [load]);

  const k = data?.kpis;
  const series = data?.series ?? [];

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
        <div className="flex flex-wrap items-center gap-2">
          <select
            value={days}
            onChange={(e) => setDays(Number(e.target.value))}
            className="text-xs bg-slate-800 border border-slate-600 text-slate-200 rounded-lg px-2 py-1.5"
          >
            <option value={14}>14 dias</option>
            <option value={30}>30 dias</option>
            <option value={60}>60 dias</option>
          </select>
          <span className="text-[10px] text-slate-500 font-mono">
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
      </header>

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
            <Zap className="w-3.5 h-3.5" /> Ativações
          </div>
          <p className="text-3xl font-bold text-violet-200 tabular-nums mt-2">
            {loading ? '…' : fmt(k?.ativacoes_hoje)}
          </p>
          <p className="text-xs text-slate-500 mt-0.5">
            hoje · {fmt(k?.ativacoes_periodo)} no período
          </p>
        </div>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
        <div className="rounded-xl border border-rose-900/50 bg-rose-950/30 p-4">
          <p className="text-[10px] uppercase tracking-wide text-rose-400 font-semibold">Novos inadimplentes</p>
          <p className="text-2xl font-bold text-rose-200 tabular-nums mt-1">{fmt(k?.novos_inadimplentes)}</p>
          <p className="text-[11px] text-slate-500 mt-1">Desde o último upload / ontem</p>
        </div>
        <div className="rounded-xl border border-emerald-900/50 bg-emerald-950/30 p-4">
          <p className="text-[10px] uppercase tracking-wide text-emerald-400 font-semibold">Recuperados</p>
          <p className="text-2xl font-bold text-emerald-200 tabular-nums mt-1">{fmt(k?.recuperados)}</p>
          <p className="text-[11px] text-slate-500 mt-1">Estavam inad. e viraram adimplente</p>
        </div>
        <div className="rounded-xl border border-slate-700 bg-slate-900/50 p-4">
          <p className="text-[10px] uppercase tracking-wide text-slate-400 font-semibold">Taxa inadimplência</p>
          <p className="text-2xl font-bold text-slate-100 tabular-nums mt-1 flex items-center gap-2">
            {fmtPct(k?.pct_inadimplente)}
            {k?.delta_inadimplente != null && k.delta_inadimplente !== 0 && (
              <TrendingDown
                className={`w-4 h-4 ${k.delta_inadimplente > 0 ? 'text-rose-400' : 'text-emerald-400'}`}
              />
            )}
          </p>
          <p className="text-[11px] text-slate-500 mt-1">Inadimplentes ÷ total EM CURSO</p>
        </div>
      </div>

      <div className="rounded-2xl border border-slate-700/80 bg-slate-900/60 p-5">
        <h3 className="text-sm font-semibold text-slate-200 mb-4">Evolução diária</h3>
        {loading ? (
          <p className="text-sm text-slate-500 py-8 text-center">Carregando…</p>
        ) : (
          <EvolutionChart series={series} />
        )}
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
                  <th className="px-3 py-2 text-right font-medium">Inad.</th>
                  <th className="px-3 py-2 text-right font-medium">Adimpl.</th>
                  <th className="px-3 py-2 text-right font-medium">Δ Inad.</th>
                  <th className="px-3 py-2 text-right font-medium">Novos inad.</th>
                  <th className="px-3 py-2 text-right font-medium">Recup.</th>
                  <th className="px-3 py-2 text-right font-medium">Ativações</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-800">
                {[...series].reverse().slice(0, 14).map((row) => (
                  <tr key={row.stat_date} className="hover:bg-slate-800/40">
                    <td className="px-3 py-2 text-slate-300">{fmtDay(row.stat_date)}</td>
                    <td className="px-3 py-2 text-right tabular-nums text-slate-200">{fmt(row.total_em_curso)}</td>
                    <td className="px-3 py-2 text-right tabular-nums text-rose-300">{fmt(row.inadimplente)}</td>
                    <td className="px-3 py-2 text-right tabular-nums text-emerald-300">{fmt(row.adimplente)}</td>
                    <td className="px-3 py-2 text-right tabular-nums text-slate-400">
                      {row.delta_inadimplente != null
                        ? (row.delta_inadimplente > 0 ? '+' : '') + fmt(row.delta_inadimplente)
                        : '—'}
                    </td>
                    <td className="px-3 py-2 text-right tabular-nums text-rose-400/80">
                      {fmt(row.novos_inadimplentes)}
                    </td>
                    <td className="px-3 py-2 text-right tabular-nums text-emerald-400/80">
                      {fmt(row.recuperados_financeiro)}
                    </td>
                    <td className="px-3 py-2 text-right tabular-nums text-violet-300">{fmt(row.ativacoes_dia)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}
