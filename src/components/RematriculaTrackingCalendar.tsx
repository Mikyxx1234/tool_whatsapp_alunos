import { useMemo } from 'react';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import type { RematriculaDailyStat } from '../services/reportApi';

const MONTH_NAMES = [
  'Janeiro', 'Fevereiro', 'Março', 'Abril', 'Maio', 'Junho',
  'Julho', 'Agosto', 'Setembro', 'Outubro', 'Novembro', 'Dezembro',
];
const DAY_NAMES = ['Seg', 'Ter', 'Qua', 'Qui', 'Sex', 'Sáb', 'Dom'];

function todayStr() {
  return new Date().toLocaleDateString('en-CA');
}

function cellStyle(inad: number, maxInad: number) {
  if (!inad) {
    return {
      bg: 'rgba(30,41,59,0.6)',
      border: 'rgba(71,85,105,0.4)',
      text: '#64748b',
    };
  }
  const t = maxInad > 0 ? Math.min(1, inad / maxInad) : 0.5;
  const alpha = 0.12 + t * 0.45;
  return {
    bg: `rgba(251,113,133,${alpha})`,
    border: `rgba(251,113,133,${0.3 + t * 0.5})`,
    text: t > 0.45 ? '#ffe4e6' : '#fda4af',
  };
}

interface Props {
  series: RematriculaDailyStat[];
  selectedDate: string | null;
  month: { year: number; month: number };
  onSelectDate: (date: string) => void;
  onMonthChange: (year: number, month: number) => void;
}

export function RematriculaTrackingCalendar({
  series,
  selectedDate,
  month,
  onSelectDate,
  onMonthChange,
}: Props) {
  const byDate = useMemo(() => {
    const m = new Map<string, RematriculaDailyStat>();
    series.forEach((s) => {
      const key = String(s.stat_date).slice(0, 10);
      if (key) m.set(key, s);
    });
    return m;
  }, [series]);

  const { year, month: mo } = month;
  const lastDay = new Date(year, mo + 1, 0).getDate();
  let startDow = new Date(year, mo, 1).getDay() - 1;
  if (startDow < 0) startDow = 6;

  let maxInad = 0;
  for (let d = 1; d <= lastDay; d++) {
    const key = `${year}-${String(mo + 1).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
    maxInad = Math.max(maxInad, byDate.get(key)?.inadimplente ?? 0);
  }

  const today = todayStr();

  return (
    <div className="rounded-xl border border-slate-700/80 bg-slate-900/50 p-4">
      <div className="flex flex-wrap items-center justify-between gap-3 mb-3">
        <p className="text-xs font-semibold text-slate-300">Calendário — inadimplentes por dia</p>
        <div className="flex items-center gap-1">
          <button
            type="button"
            onClick={() => {
              const d = new Date(year, mo - 1, 1);
              onMonthChange(d.getFullYear(), d.getMonth());
            }}
            className="p-1.5 rounded-lg border border-slate-600 text-slate-400 hover:text-sky-300 hover:border-sky-500/50"
            aria-label="Mês anterior"
          >
            <ChevronLeft className="w-4 h-4" />
          </button>
          <span className="text-xs font-bold text-slate-200 min-w-[9rem] text-center">
            {MONTH_NAMES[mo]} {year}
          </span>
          <button
            type="button"
            onClick={() => {
              const d = new Date(year, mo + 1, 1);
              onMonthChange(d.getFullYear(), d.getMonth());
            }}
            className="p-1.5 rounded-lg border border-slate-600 text-slate-400 hover:text-sky-300 hover:border-sky-500/50"
            aria-label="Próximo mês"
          >
            <ChevronRight className="w-4 h-4" />
          </button>
        </div>
      </div>

      <div className="grid grid-cols-7 gap-1.5">
        {DAY_NAMES.map((dn) => (
          <div
            key={dn}
            className="text-center text-[9px] font-bold text-slate-500 uppercase tracking-wider pb-1"
          >
            {dn}
          </div>
        ))}
        {Array.from({ length: startDow }).map((_, i) => (
          <div key={`pad-${i}`} className="aspect-square" />
        ))}
        {Array.from({ length: lastDay }).map((_, i) => {
          const day = i + 1;
          const dateStr = `${year}-${String(mo + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
          const row = byDate.get(dateStr);
          const inad = row?.inadimplente ?? 0;
          const hasData = Boolean(row);
          const st = cellStyle(inad, maxInad);
          const isToday = dateStr === today;
          const isSelected = dateStr === selectedDate;
          const ring = isSelected
            ? 'ring-2 ring-emerald-400'
            : isToday
              ? 'ring-2 ring-cyan-400'
              : '';

          return (
            <button
              key={dateStr}
              type="button"
              disabled={!hasData}
              onClick={() => hasData && onSelectDate(dateStr)}
              className={`aspect-square rounded-lg flex flex-col items-center justify-center gap-0.5 transition-all ${ring} ${
                hasData ? 'hover:scale-105 hover:z-10 cursor-pointer' : 'opacity-40 cursor-default'
              }`}
              style={{
                background: st.bg,
                border: `1px solid ${st.border}`,
              }}
              title={
                hasData
                  ? `${dateStr}: ${inad.toLocaleString('pt-BR')} inad. · ${(row?.total_em_curso ?? 0).toLocaleString('pt-BR')} em curso`
                  : `${dateStr}: sem captura`
              }
            >
              <span className="text-[11px] font-bold leading-none" style={{ color: st.text }}>
                {day}
              </span>
              {hasData && (
                <span className="text-[8px] font-mono font-semibold leading-none" style={{ color: st.text }}>
                  {inad || '·'}
                </span>
              )}
            </button>
          );
        })}
      </div>

      <div className="flex flex-wrap items-center gap-3 mt-3 pt-3 border-t border-slate-700/60 text-[10px] text-slate-500">
        <span className="flex items-center gap-1">
          <span className="w-3 h-3 rounded bg-slate-800 border border-slate-600" /> sem dado
        </span>
        <span className="flex items-center gap-1">
          <span className="w-3 h-3 rounded bg-rose-900/40 border border-rose-500/40" /> inad. baixo
        </span>
        <span className="flex items-center gap-1">
          <span className="w-3 h-3 rounded bg-rose-500/70 border border-rose-400" /> inad. alto
        </span>
        <span className="flex items-center gap-1">
          <span className="w-3 h-3 rounded ring-2 ring-cyan-400 bg-slate-800" /> hoje
        </span>
      </div>
    </div>
  );
}
