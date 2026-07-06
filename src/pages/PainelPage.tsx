import { Fragment, useCallback, useEffect, useMemo, useState } from 'react';
import { Link, Navigate } from 'react-router-dom';
import {
  RefreshCw,
  Send,
  Users,
  Edit3,
  RotateCcw,
  Target,
  TrendingUp,
  AlertTriangle,
  CheckCircle2,
  Info,
  Clock,
  BarChart3,
  Filter,
  CalendarDays,
  Layers,
  ChevronDown,
} from 'lucide-react';
import { Header } from '../components/Header';
import {
  fetchPainelOverview,
  type PainelAlerta,
  type PainelBaseRow,
  type PainelCalendarioDia,
  type PainelCalendarioMeta,
  type PainelDiarioAtivacoes,
  type PainelDiarioResumo,
  type PainelEquipeRow,
  type PainelMetaStatus,
  type PainelOverviewData,
  type PainelPerfilOption,
} from '../services/painelApi';
import {
  firstAllowedRoute,
  hasFullAccess,
  isAbaPermitida,
  readConsultorIdentity,
} from '../services/meuPainelApi';

type RangeKey = 'today' | '7d' | '30d' | '90d';
const PAINEL_PERFIL_STORAGE = 'painel_perfil_v1';
const PAINEL_ORIGEM_STORAGE = 'painel_origem_caa_v1';

export type PainelOrigemCaa = 'geral' | 'caa' | 'caa_atm' | 'caa_ia';

const ORIGEM_CAA_OPTIONS: Array<{ id: PainelOrigemCaa; label: string }> = [
  { id: 'geral', label: 'Geral' },
  { id: 'caa', label: 'CAA' },
  { id: 'caa_atm', label: 'CAA ATM' },
  { id: 'caa_ia', label: 'CAA IA' },
];

function readStoredOrigemCaa(): PainelOrigemCaa {
  try {
    const v = localStorage.getItem(PAINEL_ORIGEM_STORAGE);
    if (v && ORIGEM_CAA_OPTIONS.some((o) => o.id === v)) return v as PainelOrigemCaa;
  } catch { /* ignore */ }
  return 'geral';
}

function storeOrigemCaa(id: PainelOrigemCaa) {
  try {
    localStorage.setItem(PAINEL_ORIGEM_STORAGE, id);
  } catch { /* ignore */ }
}

function readStoredPerfil(): string {
  try {
    return localStorage.getItem(PAINEL_PERFIL_STORAGE) || 'caa';
  } catch {
    return 'caa';
  }
}

function storePerfil(id: string) {
  try {
    localStorage.setItem(PAINEL_PERFIL_STORAGE, id);
  } catch { /* ignore */ }
}

const RANGE_OPTIONS: Array<{ key: RangeKey; label: string; days: number }> = [
  { key: 'today', label: 'Hoje', days: 0 },
  { key: '7d', label: '7d', days: 7 },
  { key: '30d', label: '30d', days: 30 },
  { key: '90d', label: '90d', days: 90 },
];

const STATUS_META: Record<PainelMetaStatus, { label: string; className: string }> = {
  batendo: { label: 'Batendo meta', className: 'bg-emerald-100 text-emerald-800 border-emerald-200' },
  em_risco: { label: 'Em risco', className: 'bg-amber-100 text-amber-800 border-amber-200' },
  atrasado: { label: 'Atrasado', className: 'bg-rose-100 text-rose-800 border-rose-200' },
  sem_meta: { label: 'Sem meta', className: 'bg-gray-100 text-gray-600 border-gray-200' },
};

function localYmd(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function presetRange(key: RangeKey): { from: string; to: string } | { period_days: number } {
  const today = new Date();
  const to = localYmd(today);
  if (key === 'today') return { from: to, to };
  const days = RANGE_OPTIONS.find((r) => r.key === key)?.days ?? 30;
  const start = new Date();
  start.setDate(start.getDate() - (days - 1));
  return { from: localYmd(start), to };
}

function fmtInt(n: number): string {
  return Number(n || 0).toLocaleString('pt-BR');
}

function fmtPct(v: number | null | undefined): string {
  if (v == null || !Number.isFinite(v)) return '—';
  return `${(v * 100).toFixed(1).replace('.', ',')}%`;
}

function fmtDateBr(ymd: string): string {
  const [y, m, d] = ymd.split('-');
  return `${d}/${m}/${y?.slice(2)}`;
}

function KpiCard({
  label,
  value,
  hint,
  icon,
  tone = 'slate',
}: {
  label: string;
  value: string;
  hint?: string;
  icon: React.ReactNode;
  tone?: 'sky' | 'emerald' | 'violet' | 'amber' | 'slate';
}) {
  const tones: Record<string, string> = {
    sky: 'bg-sky-50 border-sky-100 text-sky-700',
    emerald: 'bg-emerald-50 border-emerald-100 text-emerald-700',
    violet: 'bg-violet-50 border-violet-100 text-violet-700',
    amber: 'bg-amber-50 border-amber-100 text-amber-700',
    slate: 'bg-slate-50 border-slate-100 text-slate-700',
  };
  return (
    <div className="rounded-xl border border-gray-100 bg-white p-4 shadow-sm">
      <div className={`inline-flex p-2 rounded-lg mb-3 ${tones[tone]}`}>{icon}</div>
      <p className="text-xs font-medium text-gray-500 uppercase tracking-wide">{label}</p>
      <p className="font-display text-2xl font-extrabold tracking-tight text-gray-900 mt-1 tabular-nums">{value}</p>
      {hint && <p className="text-xs text-gray-500 mt-1">{hint}</p>}
    </div>
  );
}

function AlertaCard({ alerta }: { alerta: PainelAlerta }) {
  const styles = {
    success: 'border-emerald-200 bg-emerald-50 text-emerald-900',
    warning: 'border-amber-200 bg-amber-50 text-amber-900',
    danger: 'border-rose-200 bg-rose-50 text-rose-900',
    info: 'border-sky-200 bg-sky-50 text-sky-900',
  };
  const icons = {
    success: <CheckCircle2 className="w-4 h-4 shrink-0" />,
    warning: <AlertTriangle className="w-4 h-4 shrink-0" />,
    danger: <AlertTriangle className="w-4 h-4 shrink-0" />,
    info: <Info className="w-4 h-4 shrink-0" />,
  };
  return (
    <div className={`min-w-[240px] max-w-xs rounded-xl border p-3 ${styles[alerta.tipo]}`}>
      <div className="flex items-start gap-2">
        {icons[alerta.tipo]}
        <div className="min-w-0">
          <p className="text-xs font-bold leading-snug">{alerta.titulo}</p>
          <p className="text-[11px] opacity-80 mt-0.5">{alerta.detalhe}</p>
        </div>
      </div>
    </div>
  );
}

function FunnelBar({ label, value, max, pct, tone }: { label: string; value: number; max: number; pct: string; tone: string }) {
  const width = max > 0 ? Math.max((value / max) * 100, value > 0 ? 4 : 0) : 0;
  return (
    <div>
      <div className="flex items-center justify-between text-xs mb-1">
        <span className="font-medium text-gray-700">{label}</span>
        <span className="tabular-nums text-gray-500">{fmtInt(value)} · {pct}</span>
      </div>
      <div className="h-2.5 rounded-full bg-gray-100 overflow-hidden">
        <div className={`h-full rounded-full ${tone}`} style={{ width: `${width}%` }} />
      </div>
    </div>
  );
}

function StatusPill({ status }: { status: PainelMetaStatus }) {
  const s = STATUS_META[status];
  return (
    <span className={`inline-flex px-2 py-0.5 rounded-md border text-[10px] font-bold uppercase tracking-wide ${s.className}`}>
      {s.label}
    </span>
  );
}

function EvolucaoChart({ rows, metaDia }: { rows: PainelOverviewData['evolucao_diaria']; metaDia: number }) {
  const max = Math.max(...rows.map((r) => r.marcados), metaDia, 1);
  if (!rows.length) {
    return <p className="text-sm text-gray-400 py-8 text-center">Sem dados no período</p>;
  }
  return (
    <div className="flex items-end gap-1 h-40 pt-4">
      {rows.map((r) => {
        const hMarc = (r.marcados / max) * 100;
        const hRev = (r.revertidos / max) * 100;
        const hMeta = metaDia > 0 ? (metaDia / max) * 100 : 0;
        return (
          <div key={r.dia} className="flex-1 min-w-0 flex flex-col items-center gap-1 group">
            <div className="relative w-full flex items-end justify-center gap-0.5 h-32">
              {metaDia > 0 && (
                <div
                  className="absolute left-0 right-0 border-t border-dashed border-primary/40 pointer-events-none"
                  style={{ bottom: `${hMeta}%` }}
                  title={`Meta/dia: ${metaDia}`}
                />
              )}
              <div
                className="w-[42%] bg-indigo-400 rounded-t-sm transition-all group-hover:bg-indigo-500"
                style={{ height: `${hMarc}%` }}
                title={`${fmtInt(r.marcados)} marcados`}
              />
              <div
                className="w-[42%] bg-emerald-500 rounded-t-sm transition-all group-hover:bg-emerald-600"
                style={{ height: `${hRev}%` }}
                title={`${fmtInt(r.revertidos)} revertidos`}
              />
            </div>
            <span className="text-[9px] text-gray-500 truncate w-full text-center">{fmtDateBr(r.dia)}</span>
          </div>
        );
      })}
    </div>
  );
}

function DiarioAtivacoesTable({
  dias,
  resumo,
  loading,
  maxDisparos,
}: {
  dias: PainelDiarioDia[];
  resumo?: PainelDiarioResumo | null;
  loading: boolean;
  maxDisparos: number;
}) {
  const taxaTone = (t: number | null) => {
    if (t == null) return 'text-gray-300';
    if (t >= 0.2) return 'text-emerald-600 font-semibold';
    if (t >= 0.1) return 'text-amber-600 font-medium';
    return 'text-rose-500';
  };

  return (
    <div className="overflow-x-auto max-h-[360px]">
      <table className="min-w-full text-sm">
        <thead className="sticky top-0 bg-gray-50 z-10">
          <tr className="text-left text-[11px] text-gray-400 uppercase tracking-wide border-b border-gray-100">
            <th className="px-4 py-2.5 font-semibold">Dia</th>
            <th className="px-4 py-2.5 font-semibold w-40">Disparos</th>
            <th className="px-4 py-2.5 font-semibold text-right">Pessoas</th>
            <th className="px-4 py-2.5 font-semibold text-right">Responderam</th>
            <th className="px-4 py-2.5 font-semibold text-right">Taxa resposta</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-gray-50">
          {loading && (
            <tr><td colSpan={5} className="px-4 py-10 text-center text-gray-400">Carregando…</td></tr>
          )}
          {!loading && dias.length === 0 && (
            <tr><td colSpan={5} className="px-4 py-10 text-center text-gray-400">Nenhuma ativação no período</td></tr>
          )}
          {!loading && dias.map((d) => {
            const barW = Math.max(4, (d.disparos / maxDisparos) * 100);
            const weekday = new Date(d.dia + 'T00:00:00.000Z').getUTCDay();
            const isWeekend = weekday === 0 || weekday === 6;
            return (
              <tr key={d.dia} className="hover:bg-gray-50/60 transition-colors">
                <td className="px-4 py-2.5">
                  <span className={`font-medium ${isWeekend ? 'text-gray-400' : 'text-gray-900'}`}>{fmtDateBr(d.dia)}</span>
                  <span className="ml-1.5 text-[10px] text-gray-400">{CAL_WEEKDAYS_FULL[weekday]}</span>
                </td>
                <td className="px-4 py-2.5">
                  <div className="flex items-center gap-2">
                    <div className="flex-1 h-2 rounded-full bg-gray-100 overflow-hidden min-w-[50px]">
                      <div className="h-full rounded-full bg-violet-400" style={{ width: `${barW}%` }} />
                    </div>
                    <span className="tabular-nums text-xs w-14 text-right text-gray-600">{fmtInt(d.disparos)}</span>
                  </div>
                </td>
                <td className="px-4 py-2.5 text-right tabular-nums text-gray-600">{fmtInt(d.pessoas)}</td>
                <td className="px-4 py-2.5 text-right tabular-nums text-sky-700 font-medium">{fmtInt(d.responderam)}</td>
                <td className={`px-4 py-2.5 text-right tabular-nums ${taxaTone(d.taxa_resposta)}`}>
                  {d.taxa_resposta == null ? '—' : fmtPct(d.taxa_resposta)}
                </td>
              </tr>
            );
          })}
        </tbody>
        {!loading && resumo && resumo.dias_com_ativacao > 0 && (
          <tfoot>
            <tr className="border-t border-gray-100 bg-gray-50/50 text-xs">
              <td className="px-4 py-2.5 font-semibold text-gray-500 uppercase tracking-wide">Total</td>
              <td className="px-4 py-2.5 text-right tabular-nums font-semibold text-gray-700">{fmtInt(resumo.total_disparos)}</td>
              <td className="px-4 py-2.5 text-right tabular-nums font-semibold text-gray-700">{fmtInt(resumo.total_pessoas)}</td>
              <td className="px-4 py-2.5 text-right tabular-nums font-semibold text-sky-700">{fmtInt(resumo.total_responderam)}</td>
              <td className="px-4 py-2.5 text-right tabular-nums font-semibold text-emerald-700">{fmtPct(resumo.taxa_media_ponderada)}</td>
            </tr>
          </tfoot>
        )}
      </table>
    </div>
  );
}

function DiarioAtivacoes({ diario, loading, perfilLabel }: { diario?: PainelDiarioAtivacoes; loading: boolean; perfilLabel: string }) {
  const segmentos = diario?.segmentos;
  const dias = useMemo(() => [...(diario?.dias ?? [])].reverse(), [diario]);
  const resumo = diario?.resumo;
  const maxDisparos = useMemo(() => Math.max(1, ...(diario?.dias ?? []).map((d) => d.disparos)), [diario]);

  const segmentoAccent = (id: string) => {
    if (id === 'adimplente') return 'border-emerald-200 bg-emerald-50/40';
    if (id === 'inadimplente') return 'border-amber-200 bg-amber-50/40';
    return 'border-gray-100 bg-gray-50/40';
  };

  if (segmentos?.length) {
    return (
      <section className="rounded-xl border border-gray-100 bg-white shadow-sm overflow-hidden">
        <div className="px-4 py-3 border-b border-gray-100">
          <h3 className="text-sm font-semibold text-gray-900 flex items-center gap-2">
            <CalendarDays className="w-4 h-4 text-indigo-600" />
            Diário de ativações — {perfilLabel}
          </h3>
          {resumo && resumo.dias_com_ativacao > 0 && (
            <p className="mt-1 text-xs text-gray-500">
              {resumo.dias_com_ativacao} dias com disparo · {fmtInt(resumo.total_disparos)} disparos · resposta média{' '}
              <strong className={resumo.taxa_media_ponderada != null && resumo.taxa_media_ponderada >= 0.1 ? 'text-emerald-600' : 'text-gray-700'}>
                {fmtPct(resumo.taxa_media_ponderada)}
              </strong>
            </p>
          )}
        </div>
        <div className="divide-y divide-gray-100">
          {segmentos.map((seg) => {
            const segDias = [...seg.dias].reverse();
            const segMax = Math.max(1, ...seg.dias.map((d) => d.disparos));
            const shortLabel = seg.id === 'adimplente' ? 'Adim' : 'Inad';
            return (
              <div key={seg.id} className="p-4">
                <div className={`rounded-lg border px-3 py-2 mb-3 flex flex-wrap items-center justify-between gap-2 ${segmentoAccent(seg.id)}`}>
                  <h4 className="text-sm font-semibold text-gray-900">{seg.label} <span className="text-gray-400 font-normal">({shortLabel})</span></h4>
                  {seg.resumo && seg.resumo.dias_com_ativacao > 0 && (
                    <div className="flex items-center gap-3 text-xs text-gray-600">
                      <span>{seg.resumo.dias_com_ativacao} dias</span>
                      <span>{fmtInt(seg.resumo.total_disparos)} disparos</span>
                      <span>taxa {fmtPct(seg.resumo.taxa_media_ponderada)}</span>
                    </div>
                  )}
                </div>
                <DiarioAtivacoesTable dias={segDias} resumo={seg.resumo} loading={loading} maxDisparos={segMax} />
              </div>
            );
          })}
        </div>
      </section>
    );
  }

  return (
    <section className="rounded-xl border border-gray-100 bg-white shadow-sm overflow-hidden">
      <div className="px-4 py-3 border-b border-gray-100 flex items-center justify-between flex-wrap gap-2">
        <h3 className="text-sm font-semibold text-gray-900 flex items-center gap-2">
          <CalendarDays className="w-4 h-4 text-indigo-600" />
          Diário de ativações — {perfilLabel}
        </h3>
        {resumo && resumo.dias_com_ativacao > 0 && (
          <div className="flex items-center gap-4 text-xs text-gray-500">
            <span>{resumo.dias_com_ativacao} dias com disparo</span>
            <span>·</span>
            <span>{fmtInt(resumo.total_disparos)} disparos</span>
            <span>·</span>
            <span>
              resposta média{' '}
              <strong className={resumo.taxa_media_ponderada != null && resumo.taxa_media_ponderada >= 0.1 ? 'text-emerald-600' : 'text-gray-700'}>
                {fmtPct(resumo.taxa_media_ponderada)}
              </strong>
            </span>
          </div>
        )}
      </div>
      <DiarioAtivacoesTable dias={dias} resumo={resumo} loading={loading} maxDisparos={maxDisparos} />
    </section>
  );
}

const CAL_WEEKDAYS_FULL = ['dom', 'seg', 'ter', 'qua', 'qui', 'sex', 'sáb'];

function PerfilSwitcher({
  perfilId,
  perfilLabel,
  perfis,
  onChange,
}: {
  perfilId: string;
  perfilLabel: string;
  perfis: PainelPerfilOption[];
  onChange: (id: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const caaPerfis = perfis.filter((p) => p.modo === 'caa');
  const opPerfis = perfis.filter((p) => p.modo === 'operacional');

  return (
    <div className="relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="inline-flex items-center gap-2 px-3 py-2 text-xs font-semibold text-gray-800 bg-white border border-gray-200 rounded-lg hover:bg-gray-50 shadow-sm"
      >
        <Layers className="w-3.5 h-3.5 text-indigo-600" />
        <span>{perfilLabel}</span>
        <ChevronDown className={`w-3.5 h-3.5 text-gray-400 transition-transform ${open ? 'rotate-180' : ''}`} />
      </button>
      {open && (
        <>
          <div className="fixed inset-0 z-10" onClick={() => setOpen(false)} aria-hidden />
          <div className="absolute right-0 mt-1 z-20 w-56 rounded-xl border border-gray-200 bg-white shadow-lg py-1 text-sm">
            {caaPerfis.length > 0 && (
              <>
                <p className="px-3 py-1.5 text-[10px] font-bold uppercase tracking-wide text-gray-400">CAA</p>
                {caaPerfis.map((p) => (
                  <button
                    key={p.id}
                    type="button"
                    onClick={() => { onChange(p.id); setOpen(false); }}
                    className={`w-full text-left px-3 py-2 hover:bg-indigo-50 ${p.id === perfilId ? 'text-indigo-700 font-semibold bg-indigo-50/50' : 'text-gray-700'}`}
                  >
                    {p.label}
                  </button>
                ))}
              </>
            )}
            {opPerfis.length > 0 && (
              <>
                <div className="my-1 border-t border-gray-100" />
                <p className="px-3 py-1.5 text-[10px] font-bold uppercase tracking-wide text-gray-400">Operacional</p>
                {opPerfis.map((p) => (
                  <button
                    key={p.id}
                    type="button"
                    onClick={() => { onChange(p.id); setOpen(false); }}
                    className={`w-full text-left px-3 py-2 hover:bg-gray-50 ${p.id === perfilId ? 'text-indigo-700 font-semibold bg-indigo-50/50' : 'text-gray-700'}`}
                  >
                    {p.label}
                  </button>
                ))}
              </>
            )}
          </div>
        </>
      )}
    </div>
  );
}

const CAL_STATUS_STYLE: Record<string, { cell: string; label: string; dot: string }> = {
  bateu: { cell: 'bg-emerald-500 text-white border-emerald-500', label: 'Bateu a meta', dot: 'bg-emerald-500' },
  quase: { cell: 'bg-amber-400 text-amber-950 border-amber-400', label: 'Quase (≥70%)', dot: 'bg-amber-400' },
  abaixo: { cell: 'bg-rose-400 text-white border-rose-400', label: 'Abaixo da meta', dot: 'bg-rose-400' },
  zero: { cell: 'bg-gray-100 text-gray-400 border-gray-200', label: 'Sem marcações', dot: 'bg-gray-200' },
  fim_semana: { cell: 'bg-transparent text-gray-300 border-transparent', label: 'Fim de semana', dot: 'bg-gray-100' },
  sem_meta: { cell: 'bg-gray-50 text-gray-300 border-gray-100', label: 'Sem meta', dot: 'bg-gray-100' },
  futuro: { cell: 'bg-transparent text-gray-200 border-dashed border-gray-200', label: 'Futuro', dot: 'border border-dashed border-gray-300' },
};

const CAL_MONTH_LABEL = [
  'Janeiro', 'Fevereiro', 'Março', 'Abril', 'Maio', 'Junho',
  'Julho', 'Agosto', 'Setembro', 'Outubro', 'Novembro', 'Dezembro',
];
const CAL_WEEKDAYS = ['D', 'S', 'T', 'Q', 'Q', 'S', 'S'];

function CalendarioMeta({
  calendario,
  loading,
  selectedDia,
  onSelectDia,
}: {
  calendario?: PainelCalendarioMeta;
  loading: boolean;
  selectedDia?: string | null;
  onSelectDia?: (dia: string | null) => void;
}) {
  const months = useMemo(() => {
    const dias = calendario?.dias ?? [];
    const map = new Map<string, PainelCalendarioDia[]>();
    for (const d of dias) {
      const mk = d.dia.slice(0, 7);
      if (!map.has(mk)) map.set(mk, []);
      map.get(mk)!.push(d);
    }
    return [...map.entries()].map(([mk, list]) => {
      const [y, m] = mk.split('-').map(Number);
      return { key: mk, year: y, month: m - 1, dias: list };
    });
  }, [calendario]);

  const resumo = calendario?.resumo;

  return (
    <section className="rounded-xl border border-gray-100 bg-white shadow-sm overflow-hidden">
      <div className="px-4 py-3 border-b border-gray-100 flex items-center justify-between flex-wrap gap-2">
        <h3 className="text-sm font-semibold text-gray-900 flex items-center gap-2">
          <CalendarDays className="w-4 h-4 text-indigo-600" />
          Calendário de metas
          {calendario?.meta_dia ? (
            <span className="text-xs font-normal text-gray-400">· meta {fmtInt(calendario.meta_dia)}/dia</span>
          ) : null}
        </h3>
        {resumo && resumo.dias_avaliados > 0 && (
          <span className="text-xs text-gray-500">
            Bateu em <strong className="text-emerald-600">{resumo.dias_bateram}</strong> de {resumo.dias_avaliados} dias úteis
            {resumo.taxa_sucesso != null ? ` · ${fmtPct(resumo.taxa_sucesso)}` : ''}
            {selectedDia ? (
              <>
                {' · '}
                <button
                  type="button"
                  onClick={() => onSelectDia?.(null)}
                  className="text-indigo-600 hover:underline font-medium"
                >
                  Ver período completo
                </button>
              </>
            ) : null}
          </span>
        )}
      </div>

      <div className="p-4">
        {loading ? (
          <p className="text-sm text-gray-400 py-8 text-center">Carregando…</p>
        ) : months.length === 0 ? (
          <p className="text-sm text-gray-400 py-8 text-center">Sem dados no período</p>
        ) : (
          <div className="flex flex-wrap gap-6">
            {months.map((mo) => {
              const firstDow = new Date(`${mo.key}-01T00:00:00.000Z`).getUTCDay();
              const byDay = new Map(mo.dias.map((d) => [Number(d.dia.slice(8, 10)), d]));
              const daysInMonth = new Date(Date.UTC(mo.year, mo.month + 1, 0)).getUTCDate();
              const cells: Array<PainelCalendarioDia | null> = [];
              for (let i = 0; i < firstDow; i++) cells.push(null);
              for (let dnum = 1; dnum <= daysInMonth; dnum++) {
                cells.push(byDay.get(dnum) ?? null);
              }
              return (
                <div key={mo.key} className="min-w-[224px]">
                  <p className="text-xs font-semibold text-gray-700 mb-2">
                    {CAL_MONTH_LABEL[mo.month]} <span className="text-gray-400">{mo.year}</span>
                  </p>
                  <div className="grid grid-cols-7 gap-1 mb-1">
                    {CAL_WEEKDAYS.map((w, i) => (
                      <div key={i} className="text-center text-[9px] font-medium text-gray-400">{w}</div>
                    ))}
                  </div>
                  <div className="grid grid-cols-7 gap-1">
                    {cells.map((d, i) => {
                      if (!d) return <div key={i} className="aspect-square" />;
                      const st = CAL_STATUS_STYLE[d.status] ?? CAL_STATUS_STYLE.zero;
                      const dayNum = Number(d.dia.slice(8, 10));
                      const tip = d.status === 'futuro' || d.status === 'fim_semana' || d.status === 'sem_meta'
                        ? `${fmtDateBr(d.dia)} · ${st.label}`
                        : `${fmtDateBr(d.dia)} · ${fmtInt(d.marcados)}/${fmtInt(d.meta_dia)} marcados${d.pct != null ? ` (${fmtPct(d.pct)})` : ''}`;
                      const clickable = d.status !== 'futuro' && d.status !== 'sem_meta' && Boolean(onSelectDia);
                      const isSelected = selectedDia === d.dia;
                      const cellClass = `aspect-square rounded-md border flex flex-col items-center justify-center leading-none transition-transform ${st.cell} ${
                        isSelected ? 'ring-2 ring-offset-1 ring-indigo-500 scale-105 z-10' : d.hoje && !isSelected ? 'ring-2 ring-offset-1 ring-sky-400' : ''
                      } ${clickable ? 'cursor-pointer hover:scale-105 hover:shadow-sm' : 'cursor-default'}`;
                      const inner = (
                        <>
                          <span className="text-[10px] font-semibold">{dayNum}</span>
                          {(d.status === 'bateu' || d.status === 'quase' || d.status === 'abaixo' || d.status === 'zero') && (
                            <span className="text-[8px] opacity-80 tabular-nums">{fmtInt(d.marcados)}</span>
                          )}
                        </>
                      );
                      return clickable ? (
                        <button
                          key={i}
                          type="button"
                          title={tip}
                          aria-label={tip}
                          aria-pressed={isSelected}
                          onClick={() => onSelectDia?.(isSelected ? null : d.dia)}
                          className={cellClass}
                        >
                          {inner}
                        </button>
                      ) : (
                        <div key={i} title={tip} className={cellClass}>
                          {inner}
                        </div>
                      );
                    })}
                  </div>
                </div>
              );
            })}
          </div>
        )}

        <div className="flex items-center gap-4 flex-wrap mt-4 pt-3 border-t border-gray-100 text-[10px] text-gray-500">
          {[
            ['bateu', 'Bateu'],
            ['quase', 'Quase (≥70%)'],
            ['abaixo', 'Abaixo'],
            ['zero', 'Sem marcação'],
            ['fim_semana', 'Fim de semana'],
          ].map(([k, label]) => (
            <span key={k} className="inline-flex items-center gap-1.5">
              <span className={`w-3 h-3 rounded ${CAL_STATUS_STYLE[k].dot}`} />
              {label}
            </span>
          ))}
        </div>
      </div>
    </section>
  );
}

function ConversaoPorBase({ rows, loading }: { rows: PainelBaseRow[]; loading: boolean }) {
  const ordered = useMemo(() => {
    const isCaa = (k: string) => String(k || '').startsWith('processos-caa');
    return [...rows].sort((a, b) => {
      const ca = isCaa(a.key) ? 0 : 1;
      const cb = isCaa(b.key) ? 0 : 1;
      if (ca !== cb) return ca - cb;
      return b.marcados - a.marcados || b.atribuidos - a.atribuidos;
    });
  }, [rows]);

  const totals = useMemo(
    () =>
      rows.reduce(
        (acc, r) => {
          acc.atribuidos += r.atribuidos;
          acc.marcados += r.marcados;
          acc.revertidos += r.revertidos ?? 0;
          return acc;
        },
        { atribuidos: 0, marcados: 0, revertidos: 0 }
      ),
    [rows]
  );

  const maxResp = useMemo(
    () => Math.max(0.0001, ...rows.map((r) => r.taxa_resposta ?? 0)),
    [rows]
  );

  return (
    <section className="rounded-xl border border-gray-100 bg-white shadow-sm overflow-hidden">
      <div className="px-4 py-3 border-b border-gray-100 flex items-center gap-2">
        <BarChart3 className="w-4 h-4 text-indigo-600" />
        <h3 className="text-sm font-semibold text-gray-900">Conversão por base</h3>
        <span className="text-xs text-gray-400">· no período</span>
      </div>
      <div className="overflow-x-auto">
        <table className="min-w-full text-sm">
          <thead>
            <tr className="text-left text-[11px] text-gray-400 uppercase tracking-wide border-b border-gray-100">
              <th className="px-4 py-2.5 font-semibold">Base</th>
              <th className="px-4 py-2.5 font-semibold text-right">Atribuídos</th>
              <th className="px-4 py-2.5 font-semibold text-right">Marcados</th>
              <th className="px-4 py-2.5 font-semibold text-right">Revertidos</th>
              <th className="px-4 py-2.5 font-semibold w-48">% marcação</th>
              <th className="px-4 py-2.5 font-semibold text-right">% reversão</th>
              <th className="px-4 py-2.5 font-semibold text-right">Taxa resposta</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-50">
            {loading && (
              <tr><td colSpan={7} className="px-4 py-10 text-center text-gray-400">Carregando…</td></tr>
            )}
            {!loading && ordered.length === 0 && (
              <tr><td colSpan={7} className="px-4 py-10 text-center text-gray-400">Sem dados no período</td></tr>
            )}
            {!loading && ordered.map((b, idx) => {
              const isCaa = String(b.key || '').startsWith('processos-caa');
              const prevIsCaa = idx > 0 && String(ordered[idx - 1].key || '').startsWith('processos-caa');
              const showDivider = idx > 0 && prevIsCaa && !isCaa;
              const inactive = b.marcados === 0;
              const marcPct = b.taxa_marcacao == null ? 0 : Math.min(b.taxa_marcacao, 1) * 100;
              // Barra escalada em relação ao maior valor entre as bases, com piso
              // visível — senão 8% num range 0-100% vira um pontinho invisível.
              const respPct = b.taxa_resposta == null
                ? 0
                : Math.max(8, (b.taxa_resposta / maxResp) * 100);
              return (
                <Fragment key={b.key}>
                  {showDivider && (
                    <tr>
                      <td colSpan={7} className="px-4 py-1.5 bg-gray-50/70 border-y border-gray-100">
                        <span className="text-[10px] font-semibold uppercase tracking-[0.14em] text-gray-400">
                          Outras bases · sem reversão
                        </span>
                      </td>
                    </tr>
                  )}
                  <tr className="hover:bg-gray-50/60 transition-colors">
                    <td className="px-4 py-3">
                      <div className="flex items-center gap-2.5">
                        <span className={`w-1.5 h-6 rounded-full ${isCaa ? 'bg-indigo-500' : 'bg-gray-200'}`} />
                        <span className={`font-medium ${inactive && isCaa ? 'text-gray-400' : 'text-gray-900'}`}>
                          {b.label}
                        </span>
                      </div>
                    </td>
                    <td className="px-4 py-3 text-right tabular-nums text-gray-600">{fmtInt(b.atribuidos)}</td>
                    <td className={`px-4 py-3 text-right tabular-nums font-semibold ${inactive ? 'text-gray-300' : 'text-gray-900'}`}>
                      {isCaa ? fmtInt(b.marcados) : <span className="text-gray-300">—</span>}
                    </td>
                    <td className="px-4 py-3 text-right tabular-nums">
                      {b.revertidos == null ? (
                        <span className="text-gray-300">—</span>
                      ) : b.revertidos > 0 ? (
                        <span className="inline-flex items-center rounded-full bg-emerald-50 px-2 py-0.5 text-xs font-semibold text-emerald-700">
                          {fmtInt(b.revertidos)}
                        </span>
                      ) : (
                        <span className="text-gray-300">0</span>
                      )}
                    </td>
                    <td className="px-4 py-3">
                      {isCaa ? (
                        <div className="flex items-center gap-2">
                          <div className="flex-1 h-1.5 rounded-full bg-gray-100 overflow-hidden min-w-[60px]">
                            <div className="h-full rounded-full bg-indigo-500" style={{ width: `${marcPct}%` }} />
                          </div>
                          <span className={`tabular-nums text-xs w-12 text-right ${inactive ? 'text-gray-300' : 'text-gray-600'}`}>
                            {fmtPct(b.taxa_marcacao)}
                          </span>
                        </div>
                      ) : (
                        <span className="text-gray-300 text-xs">—</span>
                      )}
                    </td>
                    <td className="px-4 py-3 text-right tabular-nums">
                      {b.taxa_reversao == null ? (
                        <span className="text-gray-300">—</span>
                      ) : (
                        <span className={b.taxa_reversao >= 0.8 ? 'text-emerald-600 font-semibold' : 'text-gray-600'}>
                          {fmtPct(b.taxa_reversao)}
                        </span>
                      )}
                    </td>
                    <td className="px-4 py-3">
                      {b.taxa_resposta == null ? (
                        <span className="block text-right text-gray-300">—</span>
                      ) : (
                        <div className="flex items-center gap-2 justify-end">
                          <div className="w-24 h-2 rounded-full bg-gray-100 overflow-hidden">
                            <div className="h-full rounded-full bg-sky-500" style={{ width: `${respPct}%` }} />
                          </div>
                          <span className="tabular-nums text-xs w-12 text-right text-gray-700 font-semibold">
                            {fmtPct(b.taxa_resposta)}
                          </span>
                        </div>
                      )}
                    </td>
                  </tr>
                </Fragment>
              );
            })}
          </tbody>
          {!loading && ordered.length > 0 && (
            <tfoot>
              <tr className="border-t border-gray-100 bg-gray-50/50 text-xs">
                <td className="px-4 py-2.5 font-semibold text-gray-500 uppercase tracking-wide">Total</td>
                <td className="px-4 py-2.5 text-right tabular-nums font-semibold text-gray-700">{fmtInt(totals.atribuidos)}</td>
                <td className="px-4 py-2.5 text-right tabular-nums font-semibold text-gray-700">{fmtInt(totals.marcados)}</td>
                <td className="px-4 py-2.5 text-right tabular-nums font-semibold text-emerald-700">{fmtInt(totals.revertidos)}</td>
                <td className="px-4 py-2.5" />
                <td className="px-4 py-2.5" />
                <td className="px-4 py-2.5" />
              </tr>
            </tfoot>
          )}
        </table>
      </div>
    </section>
  );
}

export default function PainelPage() {
  const identity = readConsultorIdentity();
  const canAccess = hasFullAccess(identity) && isAbaPermitida('painel');

  const [range, setRange] = useState<RangeKey>('30d');
  const [perfil, setPerfil] = useState(readStoredPerfil);
  const [origemCaa, setOrigemCaa] = useState<PainelOrigemCaa>(readStoredOrigemCaa);
  const [selectedDia, setSelectedDia] = useState<string | null>(null);
  const [data, setData] = useState<PainelOverviewData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const opts = presetRange(range);
      const baseOpts = 'period_days' in opts
        ? { period_days: opts.period_days, perfil }
        : { ...opts, perfil };
      const d = await fetchPainelOverview({
        ...baseOpts,
        ref_dia: selectedDia,
        origem_ativacao: perfil === 'caa' && origemCaa !== 'geral' ? origemCaa : null,
      });
      setData(d);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Erro ao carregar');
    } finally {
      setLoading(false);
    }
  }, [range, perfil, origemCaa, selectedDia]);

  const handlePerfilChange = (id: string) => {
    setPerfil(id);
    setSelectedDia(null);
    storePerfil(id);
  };

  const handleOrigemCaaChange = (id: PainelOrigemCaa) => {
    setOrigemCaa(id);
    setSelectedDia(null);
    storeOrigemCaa(id);
  };

  const handleRangeChange = (key: RangeKey) => {
    setRange(key);
    setSelectedDia(null);
  };

  const handleSelectDia = (dia: string | null) => {
    setSelectedDia(dia);
  };

  useEffect(() => {
    if (canAccess) void load();
  }, [canAccess, load]);

  const funilMax = useMemo(() => {
    if (!data) return 1;
    if (data.perfil.modo === 'operacional') {
      return Math.max(data.funil.total_atribuido ?? 0, data.funil.total_responderam ?? 0, 1);
    }
    return Math.max(data.funil.total_atribuido ?? 0, data.funil.total_marcado ?? 0, data.funil.total_revertido ?? 0, 1);
  }, [data]);

  if (!hasFullAccess(identity)) {
    return <Navigate to={firstAllowedRoute()} replace />;
  }
  if (!isAbaPermitida('painel')) {
    return <Navigate to={firstAllowedRoute()} replace />;
  }

  const mp = data?.meu_painel;
  const cv = data?.conversao;
  const aging = data?.pendentes.aging;
  const isCaa = data?.perfil.modo === 'caa';
  const perfilLabel = data?.perfil.label ?? 'Processos CAA';
  const perfis = data?.perfis_disponiveis ?? [];
  const origemAtivo = perfil === 'caa' && origemCaa !== 'geral';
  const isMovimentacaoInterna = perfil === 'caa' && (origemCaa === 'caa_atm' || origemCaa === 'caa_ia');
  const showWhatsappMetrics = cv?.whatsapp_metrics !== false;
  const origemLabel = ORIGEM_CAA_OPTIONS.find((o) => o.id === origemCaa)?.label;
  const refDia = data?.period.ref_dia ?? selectedDia;
  const hojeBrt = new Date().toLocaleDateString('en-CA', { timeZone: 'America/Sao_Paulo' });
  const diaLabel = refDia ? fmtDateBr(refDia) : 'hoje';
  const showProjecao = !refDia || refDia === hojeBrt;
  const diarioResumo = data?.diario_ativacoes?.resumo;
  const respostaKpi = isCaa
    ? {
        total: cv?.unique_responders ?? 0,
        taxa: cv?.response_rate ?? 0,
      }
    : {
        total: diarioResumo?.total_responderam ?? cv?.unique_responders ?? 0,
        taxa: diarioResumo?.taxa_media_ponderada ?? cv?.response_rate ?? 0,
      };
  const disparosHint = isCaa
    ? `${fmtInt(cv?.unique_dispatched ?? 0)} pessoas únicas`
    : `${fmtInt(diarioResumo?.total_pessoas ?? cv?.unique_dispatched ?? 0)} pessoas-dia`;

  return (
    <div className="min-h-screen bg-gray-50">
      <Header showHistoryButton={false} />
      <main className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-6 space-y-6">
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
          <div>
            <h2 className="font-display text-xl font-extrabold tracking-tight text-gray-900">Painel Geral</h2>
            <p className="text-sm text-gray-500">
              {isCaa
                ? `Gestão CAA — metas e respostas sem marcação${origemAtivo && origemLabel ? ` · ${origemLabel}` : ''}${isMovimentacaoInterna ? ' · movimentação DataCrazy' : ''}`
                : `${perfilLabel} — disparos e taxa de resposta`}
              {refDia
                ? ` · dia ${refDia.split('-').reverse().join('/')}`
                : data?.period.meta_referencia_dia
                  ? ` · hoje ${data.period.meta_referencia_dia.split('-').reverse().join('/')}`
                  : ''}
            </p>
          </div>
          <div className="flex items-center gap-2 flex-wrap">
            <PerfilSwitcher
              perfilId={perfil}
              perfilLabel={perfilLabel}
              perfis={perfis}
              onChange={handlePerfilChange}
            />
            {perfil === 'caa' && (
              <div className="inline-flex rounded-lg border border-gray-200 bg-white p-0.5">
                {ORIGEM_CAA_OPTIONS.map((opt) => (
                  <button
                    key={opt.id}
                    type="button"
                    onClick={() => handleOrigemCaaChange(opt.id)}
                    className={`px-3 py-1.5 text-xs font-medium rounded-md transition-colors ${
                      origemCaa === opt.id
                        ? 'bg-indigo-600 text-white'
                        : 'text-gray-600 hover:bg-gray-50'
                    }`}
                  >
                    {opt.label}
                  </button>
                ))}
              </div>
            )}
            <div className="inline-flex rounded-lg border border-gray-200 bg-white p-0.5">
              {RANGE_OPTIONS.map((opt) => (
                <button
                  key={opt.key}
                  type="button"
                  onClick={() => handleRangeChange(opt.key)}
                  className={`px-3 py-1.5 text-xs font-medium rounded-md transition-colors ${
                    range === opt.key
                      ? 'bg-whatsapp-500 text-white'
                      : 'text-gray-600 hover:bg-gray-50'
                  }`}
                >
                  {opt.label}
                </button>
              ))}
            </div>
            <Link
              to="/metas"
              className={`inline-flex items-center gap-1.5 px-3 py-2 text-xs font-semibold text-indigo-700 bg-indigo-50 border border-indigo-200 rounded-lg hover:bg-indigo-100 ${!isCaa ? 'hidden' : ''}`}
            >
              <Target className="w-3.5 h-3.5" />
              Metas
            </Link>
            <button
              type="button"
              onClick={() => void load()}
              className="inline-flex items-center gap-1.5 px-3 py-2 text-xs font-medium text-gray-700 bg-white border border-gray-200 rounded-lg hover:bg-gray-50"
            >
              <RefreshCw className={`w-3.5 h-3.5 ${loading ? 'animate-spin' : ''}`} />
              Atualizar
            </button>
          </div>
        </div>

        {error && (
          <div className="p-4 rounded-lg bg-rose-50 border border-rose-200 text-rose-700 text-sm">
            {error}
          </div>
        )}

        {refDia && isCaa && (
          <div className="flex items-center justify-between gap-3 rounded-lg border border-indigo-200 bg-indigo-50/60 px-4 py-2.5 text-sm text-indigo-900">
            <span>
              Exibindo dados do dia <strong>{fmtDateBr(refDia)}</strong> — KPIs, equipe e conversão por base
            </span>
            <button
              type="button"
              onClick={() => handleSelectDia(null)}
              className="shrink-0 text-xs font-semibold text-indigo-700 hover:underline"
            >
              Voltar ao período
            </button>
          </div>
        )}

        {!loading && (data?.alertas.length ?? 0) > 0 && (
          <section className="space-y-2">
            <h3 className="text-xs font-bold uppercase tracking-[0.14em] text-gray-500">Alertas</h3>
            <div className="flex gap-3 overflow-x-auto pb-1 scrollbar-thin">
              {data?.alertas.map((a, i) => (
                <AlertaCard key={`${a.titulo}-${i}`} alerta={a} />
              ))}
            </div>
          </section>
        )}

        <div className={`grid grid-cols-1 sm:grid-cols-2 gap-3 ${isCaa ? 'lg:grid-cols-3 xl:grid-cols-6' : 'lg:grid-cols-2'}`}>
          <KpiCard tone="sky" label="Disparos enviados" value={loading ? '…' : showWhatsappMetrics ? fmtInt(cv?.total_dispatches ?? 0) : '—'} hint={loading ? undefined : showWhatsappMetrics ? disparosHint : 'Sem disparo WhatsApp'} icon={<Send className="w-4 h-4" />} />
          <KpiCard tone="emerald" label="Responderam" value={loading ? '…' : showWhatsappMetrics ? fmtInt(respostaKpi.total) : '—'} hint={loading ? undefined : showWhatsappMetrics ? fmtPct(respostaKpi.taxa) : 'N/A para ATM/IA'} icon={<Users className="w-4 h-4" />} />
          {isCaa ? (
            <>
              <KpiCard tone="emerald" label="Revertidos" value={loading ? '…' : fmtInt(cv?.unique_reverted ?? 0)} icon={<RotateCcw className="w-4 h-4" />} />
              <KpiCard tone="violet" label="Atribuídos" value={loading ? '…' : fmtInt(mp?.total_atribuido ?? 0)} hint="recebidos no período" icon={<Users className="w-4 h-4" />} />
              <KpiCard tone="amber" label="Marcados" value={loading ? '…' : fmtInt(mp?.total_marcado ?? 0)} hint={`reversão ${fmtPct(mp?.taxa_reversao ?? 0)}`} icon={<Edit3 className="w-4 h-4" />} />
              <KpiCard
                tone="slate"
                label={`Meta do time (${diaLabel})`}
                value={loading ? '…' : data?.metas_resumo.meta_total ? `${fmtInt(data.metas_resumo.marcado_total)} / ${fmtInt(data.metas_resumo.meta_total)}` : '—'}
                hint={
                  loading
                    ? undefined
                    : data?.projecao_meta.projecao_fim_dia != null
                      ? `projeção ${data.projecao_meta.projecao_fim_dia} · ${fmtPct(data.projecao_meta.pct_projecao)}`
                      : fmtPct(data?.metas_resumo.pct_meta_global)
                }
                icon={<Target className="w-4 h-4" />}
              />
            </>
          ) : null}
        </div>

        {isCaa ? (
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
          <section className="rounded-xl border border-gray-100 bg-white shadow-sm p-4 space-y-4">
            <h3 className="text-sm font-semibold text-gray-900 flex items-center gap-2">
              <Filter className="w-4 h-4 text-indigo-600" />
              Funil de atendimento (período)
            </h3>
            {loading ? (
              <p className="text-sm text-gray-400">Carregando…</p>
            ) : (
              <div className="space-y-4">
                <FunnelBar label="Atribuídos" value={data?.funil.total_atribuido ?? 0} max={funilMax} pct="100%" tone="bg-violet-500" />
                <FunnelBar label="Marcados" value={data?.funil.total_marcado ?? 0} max={funilMax} pct={fmtPct(data?.funil.taxa_marcacao)} tone="bg-indigo-500" />
                <FunnelBar label="Revertidos" value={data?.funil.total_revertido ?? 0} max={funilMax} pct={fmtPct(data?.funil.taxa_reversao)} tone="bg-emerald-500" />
              </div>
            )}
          </section>

          {isCaa && showProjecao && (
          <section className="rounded-xl border border-gray-100 bg-white shadow-sm p-4 space-y-3">
            <h3 className="text-sm font-semibold text-gray-900 flex items-center gap-2">
              <Clock className="w-4 h-4 text-indigo-600" />
              Projeção da meta ({diaLabel})
            </h3>
            {loading ? (
              <p className="text-sm text-gray-400">Carregando…</p>
            ) : !data?.metas_resumo.meta_total ? (
              <p className="text-sm text-gray-500">Cadastre metas em Metas para ver projeção.</p>
            ) : (
              <>
                <div className="grid grid-cols-2 gap-3 text-sm">
                  <div className="rounded-lg bg-gray-50 p-3">
                    <p className="text-[10px] uppercase tracking-wide text-gray-500">Agora</p>
                    <p className="font-display text-xl font-extrabold tabular-nums">
                      {fmtInt(data.metas_resumo.marcado_total)} / {fmtInt(data.metas_resumo.meta_total)}
                    </p>
                  </div>
                  <div className="rounded-lg bg-gray-50 p-3">
                    <p className="text-[10px] uppercase tracking-wide text-gray-500">Projeção fim do dia</p>
                    <p className="font-display text-xl font-extrabold tabular-nums text-primary">
                      {data.projecao_meta.projecao_fim_dia ?? '—'}
                    </p>
                  </div>
                </div>
                <p className="text-xs text-gray-500">
                  Ritmo do dia: {data.projecao_meta.elapsed_hours}h de {data.projecao_meta.total_hours}h úteis
                  ({fmtPct(data.projecao_meta.pct_dia)} do expediente)
                </p>
                <div className="h-2 rounded-full bg-gray-100 overflow-hidden">
                  <div
                    className="h-full bg-primary rounded-full"
                    style={{ width: `${Math.min((data.metas_resumo.pct_meta_global ?? 0) * 100, 100)}%` }}
                  />
                </div>
              </>
            )}
          </section>
          )}
        </div>
        ) : null}

        {isCaa && (
          <section className="rounded-xl border border-gray-100 bg-white shadow-sm p-4">
            <div className="flex items-center justify-between mb-3">
              <h3 className="text-sm font-semibold text-gray-900 flex items-center gap-2">
                <BarChart3 className="w-4 h-4 text-indigo-600" />
                Evolução diária — marcados vs revertidos
              </h3>
              <div className="flex items-center gap-3 text-[10px] text-gray-500">
                <span className="inline-flex items-center gap-1"><span className="w-2 h-2 rounded-sm bg-indigo-400" /> Marcados</span>
                <span className="inline-flex items-center gap-1"><span className="w-2 h-2 rounded-sm bg-emerald-500" /> Revertidos</span>
                {data?.metas_resumo.meta_total ? (
                  <span className="inline-flex items-center gap-1"><span className="w-4 border-t border-dashed border-primary/50" /> Meta/dia</span>
                ) : null}
              </div>
            </div>
            {loading ? <p className="text-sm text-gray-400 py-8 text-center">Carregando…</p> : (
              <EvolucaoChart rows={data?.evolucao_diaria ?? []} metaDia={data?.metas_resumo.meta_total ?? 0} />
            )}
          </section>
        )}

        {showWhatsappMetrics && (
          <DiarioAtivacoes diario={data?.diario_ativacoes} loading={loading} perfilLabel={perfilLabel} />
        )}

        {isCaa && (
          <CalendarioMeta
            calendario={data?.calendario_meta}
            loading={loading}
            selectedDia={refDia}
            onSelectDia={handleSelectDia}
          />
        )}

        {isCaa && (
        <>
        <section className="rounded-xl border border-gray-100 bg-white shadow-sm overflow-hidden">
          <div className="px-4 py-3 border-b border-gray-100 flex items-center justify-between">
            <h3 className="text-sm font-semibold text-gray-900 flex items-center gap-2">
              <TrendingUp className="w-4 h-4 text-indigo-600" />
              Ranking — time CAA ({diaLabel})
            </h3>
            <span className="text-xs text-gray-500">{data?.equipe.length ?? 0} consultores com meta</span>
          </div>
          <div className="overflow-x-auto">
            <table className="min-w-full text-sm">
              <thead className="bg-gray-50 text-left text-xs text-gray-500 uppercase">
                <tr>
                  <th className="px-4 py-2 font-medium">#</th>
                  <th className="px-4 py-2 font-medium">Consultor</th>
                  <th className="px-4 py-2 font-medium">Status</th>
                  <th className="px-4 py-2 font-medium text-right">Hoje</th>
                  <th className="px-4 py-2 font-medium text-right">Revert.</th>
                  <th className="px-4 py-2 font-medium text-right">Taxa rev.</th>
                  <th className="px-4 py-2 font-medium text-right">Meta/dia</th>
                  <th className="px-4 py-2 font-medium text-right">%</th>
                  <th className="px-4 py-2 font-medium text-right">Sem marcação</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {loading && (
                  <tr><td colSpan={9} className="px-4 py-8 text-center text-gray-400">Carregando…</td></tr>
                )}
                {!loading && (data?.equipe.length ?? 0) === 0 && (
                  <tr><td colSpan={9} className="px-4 py-8 text-center text-gray-400">Nenhum consultor CAA com meta cadastrada</td></tr>
                )}
                {!loading && data?.equipe.map((row: PainelEquipeRow) => (
                  <tr key={row.consultor_nome} className="hover:bg-gray-50/80">
                    <td className="px-4 py-2.5 text-gray-400 font-mono text-xs">{row.ranking}</td>
                    <td className="px-4 py-2.5 font-medium text-gray-900">{row.consultor_nome}</td>
                    <td className="px-4 py-2.5"><StatusPill status={row.status_meta} /></td>
                    <td className="px-4 py-2.5 text-right tabular-nums">{fmtInt(row.total_marcado)}</td>
                    <td className="px-4 py-2.5 text-right tabular-nums text-emerald-700">{fmtInt(row.total_revertido)}</td>
                    <td className="px-4 py-2.5 text-right tabular-nums">{fmtPct(row.taxa_reversao)}</td>
                    <td className="px-4 py-2.5 text-right tabular-nums text-gray-600">
                      {row.meta_diaria != null ? fmtInt(row.meta_diaria) : '—'}
                    </td>
                    <td className="px-4 py-2.5 text-right tabular-nums">
                      {row.pct_meta != null ? (
                        <span className={row.pct_meta >= 1 ? 'text-emerald-600 font-semibold' : row.pct_meta >= 0.7 ? 'text-amber-600' : 'text-gray-600'}>
                          {fmtPct(row.pct_meta)}
                        </span>
                      ) : '—'}
                    </td>
                    <td className="px-4 py-2.5 text-right tabular-nums">
                      <span className={row.pendentes_24h_plus > 0 ? 'text-rose-600 font-semibold' : ''}>
                        {fmtInt(row.pendentes)}
                      </span>
                      {row.pendentes_24h_plus > 0 && (
                        <span className="block text-[10px] text-rose-500">{row.pendentes_24h_plus} +24h</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>

        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
          <section className="rounded-xl border border-gray-100 bg-white shadow-sm p-4">
            <h3 className="text-sm font-semibold text-gray-900 mb-1">Fila de marcação — por tempo de espera</h3>
            <p className="text-xs text-gray-500 mb-3">Respostas CAA que chegaram e ainda estão sem desfecho marcado</p>
            {loading ? (
              <p className="text-sm text-gray-400">Carregando…</p>
            ) : (
              <div className="grid grid-cols-2 gap-2">
                {[
                  { label: '0–4h', value: aging?.age_0_4h ?? 0, tone: 'bg-emerald-500' },
                  { label: '4–24h', value: aging?.age_4_24h ?? 0, tone: 'bg-amber-500' },
                  { label: '1–3 dias', value: aging?.age_1_3d ?? 0, tone: 'bg-orange-500' },
                  { label: '+3 dias', value: aging?.age_3d_plus ?? 0, tone: 'bg-rose-600' },
                ].map((b) => (
                  <div key={b.label} className="rounded-lg border border-gray-100 p-3">
                    <p className="text-[10px] uppercase tracking-wide text-gray-500">{b.label}</p>
                    <p className="font-display text-2xl font-extrabold tabular-nums">{fmtInt(b.value)}</p>
                    <div className="mt-2 h-1.5 rounded-full bg-gray-100 overflow-hidden">
                      <div
                        className={`h-full rounded-full ${b.tone}`}
                        style={{ width: `${aging?.total ? (b.value / aging.total) * 100 : 0}%` }}
                      />
                    </div>
                  </div>
                ))}
              </div>
            )}
          </section>

          <section className="rounded-xl border border-gray-100 bg-white shadow-sm overflow-hidden">
            <div className="px-4 py-3 border-b border-gray-100">
              <h3 className="text-sm font-semibold text-gray-900">Fila de marcação — por consultor CAA</h3>
              <p className="mt-1 text-xs text-gray-500">Total de respostas pendentes e quantas já passaram de 24h</p>
            </div>
            <div className="overflow-x-auto max-h-64">
              <table className="min-w-full text-xs">
                <thead className="bg-gray-50 text-gray-500 uppercase">
                  <tr>
                    <th className="px-3 py-2 text-left">Consultor</th>
                    <th className="px-3 py-2 text-right">Total</th>
                    <th className="px-3 py-2 text-right">Atrasadas (+24h)</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-100">
                  {loading && <tr><td colSpan={3} className="px-3 py-6 text-center text-gray-400">Carregando…</td></tr>}
                  {!loading && (data?.pendentes.por_consultor.length ?? 0) === 0 && (
                    <tr><td colSpan={3} className="px-3 py-6 text-center text-gray-400">Nenhuma resposta aguardando marcação</td></tr>
                  )}
                  {!loading && data?.pendentes.por_consultor.map((p) => {
                    const velhos = p.age_4_24h + p.age_1_3d + p.age_3d_plus;
                    return (
                      <tr key={p.consultor_nome} className="hover:bg-gray-50/80">
                        <td className="px-3 py-2 font-medium text-gray-900">{p.consultor_nome}</td>
                        <td className="px-3 py-2 text-right tabular-nums">{fmtInt(p.pendentes)}</td>
                        <td className={`px-3 py-2 text-right tabular-nums ${velhos > 0 ? 'text-rose-600 font-semibold' : ''}`}>
                          {fmtInt(velhos)}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </section>
        </div>
        </>
        )}

        {isCaa && <ConversaoPorBase rows={data?.por_base ?? []} loading={loading} />}
      </main>
    </div>
  );
}
