import {
  CheckCircle2,
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
  Icon: typeof Database;
}> = [
  { id: 'full', n: '1', label: 'Full Sync', hint: 'Só espelho local', Icon: Database },
  { id: 'provision', n: '2', label: 'Leads novos', hint: 'Cria no CRM', Icon: UserPlus },
  { id: 'flags', n: '3', label: 'Att de etapas', hint: 'Flags + etapa', Icon: CheckCircle2 },
  { id: 'dedupe', n: '4', label: 'Dedupe', hint: 'Escopo do card 4', Icon: UserRound },
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
  const allSelected =
    order.length === ITEMS.length && ITEMS.every((it, i) => order[i] === it.id);

  return (
    <div className="rounded-xl border border-gray-200 bg-white p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="min-w-0">
          <p className="text-xs font-semibold text-gray-900">Fila de sync</p>
          <p className="text-[11px] text-gray-500 mt-0.5">
            Clique na ordem. Todas = Full → Leads → Att → Dedupe. Uma de cada vez.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-1.5">
          <button
            type="button"
            onClick={onSelectAll}
            disabled={running || disabled}
            className={`px-2.5 py-1.5 text-[11px] font-medium rounded-lg border disabled:opacity-50 ${
              allSelected
                ? 'border-indigo-500 bg-indigo-600 text-white'
                : 'border-gray-200 bg-white text-gray-700 hover:bg-gray-50'
            }`}
          >
            Todas
          </button>
          <button
            type="button"
            onClick={onClear}
            disabled={running || disabled || order.length === 0}
            className="px-2.5 py-1.5 text-[11px] font-medium rounded-lg border border-gray-200 bg-white text-gray-700 hover:bg-gray-50 disabled:opacity-50"
          >
            Limpar
          </button>
          {!running ? (
            <button
              type="button"
              onClick={onAskRun}
              disabled={disabled || order.length === 0 || confirmOpen}
              className="inline-flex items-center gap-1.5 px-2.5 py-1.5 text-[11px] font-medium text-white bg-indigo-600 hover:bg-indigo-700 rounded-lg disabled:opacity-50 disabled:cursor-not-allowed"
            >
              <Play className="w-3 h-3 fill-current" />
              Rodar fila
            </button>
          ) : (
            <button
              type="button"
              onClick={onStop}
              className="inline-flex items-center gap-1.5 px-2.5 py-1.5 text-[11px] font-medium text-rose-700 bg-white border border-rose-300 hover:bg-rose-50 rounded-lg"
            >
              <Square className="w-3 h-3 fill-current" />
              Parar fila
            </button>
          )}
        </div>
      </div>

      <div className="mt-3 grid grid-cols-2 xl:grid-cols-4 gap-2">
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
              className={`rounded-lg border px-3 py-2.5 text-left transition disabled:cursor-not-allowed ${
                selected
                  ? 'border-indigo-500 bg-gray-100 ring-1 ring-indigo-500'
                  : 'border-gray-200 bg-gray-50 hover:border-gray-300 hover:bg-gray-100'
              }`}
            >
              <div className="flex items-center justify-between gap-2">
                <it.Icon className="w-4 h-4 shrink-0 text-gray-500" />
                <span
                  className={`inline-flex h-5 min-w-[1.25rem] items-center justify-center rounded-full text-[10px] font-bold ${
                    selected
                      ? 'bg-indigo-600 text-white'
                      : 'bg-gray-100 text-gray-400'
                  }`}
                >
                  {selected ? seq + 1 : it.n}
                </span>
              </div>
              <p className="mt-2 text-xs font-semibold text-gray-900 leading-tight">{it.label}</p>
              <p className="mt-0.5 text-[10px] text-gray-500">{it.hint}</p>
              {isCurrent ? (
                <p className="mt-1 text-[10px] font-semibold text-indigo-700">Rodando…</p>
              ) : done ? (
                <p className="mt-1 text-[10px] font-medium text-gray-500">Feito</p>
              ) : null}
            </button>
          );
        })}
      </div>

      <p className="mt-2 text-[11px] text-gray-500">
        {order.length === 0
          ? 'Nenhuma etapa na fila.'
          : `Ordem: ${order.map((id, i) => `${i + 1}. ${LABEL[id]}`).join(' → ')}`}
      </p>

      {confirmOpen && (
        <div className="mt-3 rounded-lg border border-gray-200 bg-gray-50 px-3 py-2.5 text-[11px] text-gray-800 space-y-1.5">
          <p className="font-semibold text-gray-900">Rodar nesta ordem?</p>
          <ol className="list-decimal list-inside space-y-0.5 text-gray-600">
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
              className="inline-flex items-center gap-1 px-3 py-1.5 rounded-lg bg-indigo-600 text-white text-[11px] font-medium hover:bg-indigo-700"
            >
              <Play className="w-3 h-3 fill-current" />
              Confirmar fila
            </button>
            <button
              type="button"
              onClick={onCancelConfirm}
              className="px-3 py-1.5 rounded-lg border border-gray-200 bg-white text-[11px] font-medium text-gray-700 hover:bg-gray-50"
            >
              Voltar
            </button>
          </div>
        </div>
      )}

      {message ? (
        <p className="mt-2 text-[11px] font-medium text-gray-700">{message}</p>
      ) : null}
    </div>
  );
}
