import { useMemo } from 'react';
import { ArrowDownRight, ArrowUpRight, Minus } from 'lucide-react';
import type { BaseSnapshotDto } from '../services/baseUploadApi';

function fmtDt(iso: string | undefined) {
  if (!iso) return '—';
  return new Date(iso).toLocaleString('pt-BR', {
    day: '2-digit',
    month: '2-digit',
    year: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });
}

function sourceLabel(source: string | undefined) {
  if (source === 'siaa') return 'SIAA';
  if (source === 'portal-de-polos') return 'Portal de Polos';
  return '—';
}

function recencyWidthPct(index: number, total: number) {
  if (total <= 1) return 100;
  const minPct = 42;
  const maxPct = 100;
  const t = index / Math.max(total - 1, 1);
  return Math.round(maxPct - t * (maxPct - minPct));
}

function DeltaVsOlder({
  current,
  older,
}: {
  current: number;
  older: number | null;
}) {
  if (older == null) {
    return <span className="text-[10px] text-gray-400">primeiro upload</span>;
  }
  const delta = current - older;
  if (delta === 0) {
    return (
      <span className="inline-flex items-center gap-0.5 text-[10px] font-medium text-gray-400">
        <Minus className="w-3 h-3" /> igual ao anterior
      </span>
    );
  }
  const improved = delta < 0;
  return (
    <span
      className={`inline-flex items-center gap-0.5 text-[10px] font-semibold tabular-nums ${
        improved ? 'text-emerald-600' : 'text-rose-600'
      }`}
      title={improved ? 'Menos linhas que o upload anterior (melhor)' : 'Mais linhas que o upload anterior'}
    >
      {improved ? (
        <ArrowDownRight className="w-3 h-3" />
      ) : (
        <ArrowUpRight className="w-3 h-3" />
      )}
      {delta > 0 ? '+' : ''}
      {delta.toLocaleString('pt-BR')} vs anterior
    </span>
  );
}

interface Props {
  snapshots: BaseSnapshotDto[];
  activeSnapshotId: string | null;
  loading?: boolean;
}

export function RematriculaSnapshotHistory({ snapshots, activeSnapshotId, loading }: Props) {
  const ordered = useMemo(
    () =>
      [...snapshots].sort(
        (a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime()
      ),
    [snapshots]
  );

  if (loading) {
    return (
      <div className="px-4 pb-4 pt-1">
        <p className="text-[11px] text-gray-400 animate-pulse">Carregando histórico…</p>
      </div>
    );
  }

  if (!ordered.length) {
    return (
      <div className="px-4 pb-4 pt-1 border-t border-gray-100">
        <p className="text-[11px] text-gray-400">Nenhum upload registrado ainda.</p>
      </div>
    );
  }

  const show = ordered.slice(0, 15);

  return (
    <div className="px-4 pb-4 pt-3 border-t border-gray-100">
      <div className="flex flex-wrap items-baseline justify-between gap-2 mb-3">
        <div>
          <h4 className="text-xs font-semibold text-gray-800">Histórico de uploads</h4>
          <p className="text-[10px] text-gray-500 mt-0.5">
            Quanto <strong className="text-gray-600">menos linhas</strong>, melhor — compara com o upload anterior.
          </p>
        </div>
        <span className="text-[10px] text-gray-400 tabular-nums">{ordered.length} snapshot(s)</span>
      </div>

      <ul className="space-y-2">
        {show.map((snap, index) => {
          const widthPct = recencyWidthPct(index, show.length);
          const isActive = snap.id === activeSnapshotId;
          const older = show[index + 1]?.row_count ?? null;

          return (
            <li key={snap.id} className="flex justify-start">
              <div
                className={`rounded-xl border transition-all ${
                  isActive
                    ? 'border-whatsapp-400 bg-whatsapp-50/50 shadow-sm'
                    : 'border-gray-200 bg-gray-50/80'
                }`}
                style={{ width: `${widthPct}%`, minWidth: 'min(100%, 280px)' }}
              >
                <div className="px-3 py-2 flex flex-wrap items-center gap-x-2 gap-y-1">
                  <span
                    className={`text-sm font-bold tabular-nums ${
                      isActive ? 'text-whatsapp-800' : 'text-gray-800'
                    }`}
                  >
                    {snap.row_count.toLocaleString('pt-BR')}
                  </span>
                  <span className="text-[10px] text-gray-500">linhas</span>
                  {isActive && (
                    <span className="text-[9px] font-semibold uppercase tracking-wide text-whatsapp-800 bg-whatsapp-100 px-1.5 py-0.5 rounded">
                      Ativo
                    </span>
                  )}
                  <span className="text-[10px] font-medium text-gray-600 bg-white/80 border border-gray-100 px-1.5 py-0.5 rounded">
                    {sourceLabel(snap.source)}
                  </span>
                </div>
                <div className="px-3 pb-2 flex flex-col gap-0.5">
                  <p
                    className="text-[10px] text-gray-600 truncate"
                    title={snap.file_name}
                  >
                    {snap.file_name}
                  </p>
                  <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
                    <span className="text-[10px] text-gray-400">{fmtDt(snap.created_at)}</span>
                    <DeltaVsOlder current={snap.row_count} older={older} />
                  </div>
                </div>
              </div>
            </li>
          );
        })}
      </ul>

      {ordered.length > show.length && (
        <p className="text-[10px] text-gray-400 mt-2">
          Mostrando os {show.length} uploads mais recentes de {ordered.length}.
        </p>
      )}
    </div>
  );
}
