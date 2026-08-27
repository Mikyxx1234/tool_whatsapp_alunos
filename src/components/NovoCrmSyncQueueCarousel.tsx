import { useRef } from 'react';
import {
  CheckCircle2,
  ChevronLeft,
  ChevronRight,
  Database,
  Play,
  Square,
  UserPlus,
  UserRound,
} from 'lucide-react';

export type NovoCrmSyncKind = 'full' | 'provision' | 'flags' | 'dedupe';

export const NOVO_CRM_SYNC_QUEUE_DEFAULT: NovoCrmSyncKind[] = [
  'full',
  'provision',
  'flags',
  'dedupe',
];

const ITEMS: Array<{
  id: NovoCrmSyncKind;
  n: string;
  label: string;
  hint: string;
  ring: string;
  bg: string;
  text: string;
  Icon: typeof Database;
}> = [
  {
    id: 'full',
    n: '1',
    label: 'Full Sync',
    hint: 'Só espelho local',
    ring: 'ring-indigo-400',
    bg: 'bg-indigo-50',
    text: 'text-indigo-950',
    Icon: Database,
  },
  {
    id: 'provision',
    n: '2',
    label: 'Leads novos',
    hint: 'Cria no CRM',
    ring: 'ring-sky-400',
    bg: 'bg-sky-50',
    text: 'text-sky-950',
    Icon: UserPlus,
  },
  {
    id: 'flags',
    n: '3',
    label: 'Att de etapas',
    hint: 'Flags + etapa',
    ring: 'ring-emerald-400',
    bg: 'bg-emerald-50',
    text: 'text-emerald-950',
    Icon: CheckCircle2,
  },
  {
    id: 'dedupe',
    n: '4',
    label: 'Dedupe',
    hint: 'Escopo do card 4',
    ring: 'ring-violet-400',
    bg: 'bg-violet-50',
    text: 'text-violet-950',
    Icon: UserRound,
  },
];

const LABEL: Record<NovoCrmSyncKind, string> = {
  full: 'Full Sync',
  provision: 'Leads novos',
  flags: 'Att de etapas',
  dedupe: 'Dedupe',
};

type Props = {
  order: NovoCrmSyncKind[];
  running: boolean;
  currentIndex: number;
  message: string | null;
  confirmOpen: boolean;
  dedupeScopeLabel: string;
  disabled?: boolean;
  onToggle: (id: NovoCrmSyncKind) => void;
  onSelectAll: () => void;
  onClear: () => void;
  onAskRun: () => void;
  onConfirmRun: () => void;
  onCancelConfirm: () => void;
  onStop: () => void;
};

export function NovoCrmSyncQueueCarousel({
  order,
  running,
  currentIndex,
  message,
  confirmOpen,
  dedupeScopeLabel,
  disabled,
  onToggle,
  onSelectAll,
  onClear,
  onAskRun,
  onConfirmRun,
  onCancelConfirm,
  onStop,
}: Props) {
  const scrollerRef = useRef<HTMLDivElement | null>(null);
  const allSelected =
    order.length === ITEMS.length && ITEMS.every((it, i) => order[i] === it.id);

  const scrollBy = (dir: -1 | 1) => {
    const el = scrollerRef.current;
    if (!el) return;
    el.scrollBy({ left: dir * 220, behavior: 'smooth' });
  };

  return (
    <div className="rounded-xl border border-slate-200 bg-slate-50/70 p-3 sm:p-4">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <p className="text-xs font-semibold text-slate-900">Fila de sync</p>
          <p className="text-[11px] text-slate-600 mt-0.5 max-w-xl">
            Clique nas etapas na ordem em que quer rodar. <strong>Todas</strong> usa Full →
            Leads → Att → Dedupe. Uma de cada vez; a próxima só começa quando a atual
            terminar.
          </p>
        </div>
        <div className="flex flex-wrap gap-1.5">
          <button
            type="button"
            onClick={onSelectAll}
            disabled={running || disabled}
            className="px-2.5 py-1 text-[11px] font-medium rounded-lg border border-slate-300 bg-white text-slate-800 hover:bg-slate-50 disabled:opacity-50"
          >
            Todas
          </button>
          <button
            type="button"
            onClick={onClear}
            disabled={running || disabled || order.length === 0}
            className="px-2.5 py-1 text-[11px] font-medium rounded-lg border border-slate-300 bg-white text-slate-800 hover:bg-slate-50 disabled:opacity-50"
          >
            Limpar
          </button>
        </div>
      </div>

      <div className="mt-3 flex items-center gap-1.5">
        <button
          type="button"
          onClick={() => scrollBy(-1)}
          className="shrink-0 p-1.5 rounded-full border border-slate-200 bg-white text-slate-600 hover:bg-slate-50"
          aria-label="Anterior"
        >
          <ChevronLeft className="w-4 h-4" />
        </button>
        <div
          ref={scrollerRef}
          className="flex-1 overflow-x-auto pb-1 snap-x snap-mandatory scroll-smooth [scrollbar-width:thin]"
        >
          <div className="flex gap-2 min-w-min">
            {ITEMS.map((it) => {
              const seq = order.indexOf(it.id);
              const selected = seq >= 0;
              const isCurrent = running && selected && seq === currentIndex;
              const done = running && selected && seq < currentIndex;
              return (
                <button
                  key={it.id}
                  type="button"
                  disabled={running || disabled}
                  onClick={() => onToggle(it.id)}
                  className={`snap-start shrink-0 w-[168px] rounded-2xl border px-3 py-3 text-left transition ring-offset-1 ${
                    selected
                      ? `${it.bg} ${it.text} border-transparent ring-2 ${it.ring}`
                      : 'bg-white border-slate-200 text-slate-800 hover:border-slate-300'
                  } ${isCurrent ? 'shadow-md' : ''} disabled:cursor-not-allowed`}
                >
                  <div className="flex items-center justify-between gap-2">
                    <it.Icon className="w-4 h-4 shrink-0 opacity-80" />
                    <span
                      className={`inline-flex h-5 min-w-[1.25rem] items-center justify-center rounded-full text-[10px] font-bold ${
                        selected
                          ? 'bg-white/80 text-slate-900'
                          : 'bg-slate-100 text-slate-400'
                      }`}
                    >
                      {selected ? seq + 1 : it.n}
                    </span>
                  </div>
                  <p className="mt-2 text-xs font-semibold leading-tight">{it.label}</p>
                  <p className="mt-0.5 text-[10px] opacity-80">{it.hint}</p>
                  {isCurrent ? (
                    <p className="mt-1.5 text-[10px] font-semibold">Rodando…</p>
                  ) : done ? (
                    <p className="mt-1.5 text-[10px] font-medium opacity-80">Feito</p>
                  ) : null}
                </button>
              );
            })}
          </div>
        </div>
        <button
          type="button"
          onClick={() => scrollBy(1)}
          className="shrink-0 p-1.5 rounded-full border border-slate-200 bg-white text-slate-600 hover:bg-slate-50"
          aria-label="Próximo"
        >
          <ChevronRight className="w-4 h-4" />
        </button>
      </div>

      <p className="mt-2 text-[11px] text-slate-700">
        {order.length === 0
          ? 'Nenhuma etapa na fila.'
          : `Ordem: ${order.map((id, i) => `${i + 1}. ${LABEL[id]}`).join(' → ')}`}
        {allSelected ? ' (todas)' : ''}
      </p>

      {confirmOpen && (
        <div className="mt-2 rounded-lg border border-amber-300 bg-amber-50 px-3 py-2 text-[11px] text-amber-950 space-y-1.5">
          <p className="font-semibold">Rodar nesta ordem?</p>
          <ol className="list-decimal list-inside space-y-0.5">
            {order.map((id) => (
              <li key={id}>
                {LABEL[id]}
                {id === 'provision' ? ' — cria até 1.500 leads no CRM' : ''}
                {id === 'flags' ? ' — grava flags e move etapa' : ''}
                {id === 'dedupe' ? ` — apply, escopo ${dedupeScopeLabel}` : ''}
                {id === 'full' ? ' — só atualiza o espelho' : ''}
              </li>
            ))}
          </ol>
          <div className="flex flex-wrap gap-2 pt-1">
            <button
              type="button"
              onClick={onConfirmRun}
              className="inline-flex items-center gap-1 px-3 py-1.5 rounded-lg bg-slate-900 text-white text-[11px] font-medium"
            >
              <Play className="w-3 h-3 fill-current" />
              Confirmar fila
            </button>
            <button
              type="button"
              onClick={onCancelConfirm}
              className="px-3 py-1.5 rounded-lg border border-slate-300 bg-white text-[11px] font-medium"
            >
              Voltar
            </button>
          </div>
        </div>
      )}

      <div className="mt-2 flex flex-wrap items-center gap-2">
        {!running ? (
          <button
            type="button"
            onClick={onAskRun}
            disabled={disabled || order.length === 0 || confirmOpen}
            className="inline-flex items-center gap-1.5 px-3 py-2 text-xs font-medium text-white bg-slate-900 hover:bg-slate-800 rounded-lg disabled:opacity-50 disabled:cursor-not-allowed"
          >
            <Play className="w-3.5 h-3.5 fill-current" />
            Rodar fila
          </button>
        ) : (
          <button
            type="button"
            onClick={onStop}
            className="inline-flex items-center gap-1.5 px-3 py-2 text-xs font-medium text-rose-700 bg-white border border-rose-300 hover:bg-rose-50 rounded-lg"
          >
            <Square className="w-3 h-3 fill-current" />
            Parar fila
          </button>
        )}
        {message ? (
          <p className="text-[11px] font-medium text-slate-800">{message}</p>
        ) : null}
      </div>
    </div>
  );
}
