import { useCallback, useEffect, useState } from 'react';
import { Loader2, Upload, CheckCircle2 } from 'lucide-react';
import {
  baseUploadApi,
  type BaseSnapshotDto,
  type RematriculaSource,
  type RematriculaBaseStatus,
} from '../services/baseUploadApi';
import { RematriculaSnapshotHistory } from './RematriculaSnapshotHistory';
import { isSupportedFile } from '../utils/fileToCsvText';

const SLOTS: { source: RematriculaSource; title: string; hint: string }[] = [
  {
    source: 'siaa',
    title: 'SIAA',
    hint: 'Export do SIAA (ZIP ou XLSM). Só entra SIT_ATUAL=EM CURSO — adimplente e inadimplente ficam na base.',
  },
  {
    source: 'portal-de-polos',
    title: 'Portal de Polos',
    hint: 'Relatório do Portal de Polos (mensalidade vencida, etc.).',
  },
];

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

function sourceLabel(source: string | null | undefined) {
  if (source === 'siaa') return 'SIAA';
  if (source === 'portal-de-polos') return 'Portal de Polos';
  return '—';
}

interface Props {
  onToast: (message: string, variant: 'success' | 'error' | 'info') => void;
}

export function RematriculaBasesSection({ onToast }: Props) {
  const [status, setStatus] = useState<RematriculaBaseStatus | null>(null);
  const [history, setHistory] = useState<BaseSnapshotDto[]>([]);
  const [loading, setLoading] = useState(true);
  const [historyLoading, setHistoryLoading] = useState(true);
  const [busy, setBusy] = useState<Partial<Record<RematriculaSource, boolean>>>({});

  const load = useCallback(async () => {
    setHistoryLoading(true);
    try {
      const [data, hist] = await Promise.all([
        baseUploadApi.getRematriculaStatus(),
        baseUploadApi.listSnapshots('rematricula').catch(() => ({ snapshots: [] as BaseSnapshotDto[] })),
      ]);
      setStatus(data);
      setHistory(hist.snapshots ?? []);
    } catch (e) {
      onToast(e instanceof Error ? e.message : 'Erro ao carregar base Rematrícula.', 'error');
    } finally {
      setLoading(false);
      setHistoryLoading(false);
    }
  }, [onToast]);

  useEffect(() => {
    void load();
  }, [load]);

  const uploadFiles = useCallback(
    async (source: RematriculaSource, files: FileList | File[]) => {
      const list = Array.from(files).filter(isSupportedFile);
      if (!list.length) {
        onToast('Formato não suportado. Use CSV, XLSX ou ZIP (SIAA).', 'error');
        return;
      }
      setBusy((b) => ({ ...b, [source]: true }));
      try {
        let lastRows = 0;
        for (const file of list) {
          const result = await baseUploadApi.uploadRematriculaFile(source, file);
          lastRows = result.rowCount ?? 0;
          if (result.warning) onToast(result.warning, 'error');
        }
        await load();
        onToast(
          `${sourceLabel(source)}: ${list.length} arquivo(s) importado(s) (${lastRows.toLocaleString('pt-BR')} linhas no último).`,
          'success'
        );
      } catch (e) {
        onToast(e instanceof Error ? e.message : 'Falha no upload.', 'error');
      } finally {
        setBusy((b) => ({ ...b, [source]: false }));
      }
    },
    [load, onToast]
  );

  const handlePick = (source: RematriculaSource) => {
    if (busy[source]) return;
    const input = document.createElement('input');
    input.type = 'file';
    input.multiple = true;
    input.accept =
      '.csv,.xlsx,.xls,.xlsm,.xlsb,.zip,.tsv,.txt,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,application/zip';
    input.onchange = () => {
      if (input.files?.length) void uploadFiles(source, input.files);
    };
    input.click();
  };

  const activeSource = status?.active_source ?? null;
  const activeCount = status?.active_row_count ?? 0;

  return (
    <section className="bg-white rounded-2xl border border-gray-100 shadow-sm overflow-hidden lg:col-span-2">
      <div className="px-4 py-3 border-b border-gray-100 bg-gray-50/80">
        <h3 className="text-sm font-semibold text-gray-900">Rematrícula</h3>
        <p className="text-xs text-gray-500 mt-0.5">
          Dois uploads independentes (SIAA e Portal de Polos). Para inadimplentes na fila do Disparador,
          vale o arquivo <strong className="text-gray-700">mais recente</strong> entre os dois.
        </p>
        {!loading && status?.active_snapshot && (
          <p className="mt-2 text-xs text-emerald-800 bg-emerald-50 border border-emerald-100 rounded-lg px-2.5 py-1.5 inline-flex items-center gap-1.5">
            <CheckCircle2 className="w-3.5 h-3.5 flex-shrink-0" />
            Ativo para contagem: <strong>{sourceLabel(activeSource)}</strong>
            {' · '}
            {activeCount.toLocaleString('pt-BR')} linhas
            {' · '}
            {fmtDt(status.active_snapshot.created_at)}
          </p>
        )}
        {!loading && !status?.active_snapshot && (
          <p className="mt-2 text-xs text-amber-800 bg-amber-50 border border-amber-100 rounded-lg px-2.5 py-1.5">
            Nenhum upload ainda — inadimplentes na fila ficam zerados até subir SIAA ou Portal de Polos.
          </p>
        )}
      </div>

      <div className="p-4 grid grid-cols-1 md:grid-cols-2 gap-4">
        {SLOTS.map((slot) => {
          const snap =
            slot.source === 'siaa' ? status?.siaa : status?.portal_de_polos;
          const isActive = activeSource === slot.source;
          const isBusy = Boolean(busy[slot.source]);
          return (
            <div
              key={slot.source}
              className={`rounded-xl border p-3 flex flex-col gap-2 ${
                isActive ? 'border-whatsapp-400 bg-whatsapp-50/40' : 'border-gray-200'
              }`}
            >
              <div className="flex items-center justify-between gap-2">
                <h4 className="text-sm font-semibold text-gray-900">{slot.title}</h4>
                {isActive && (
                  <span className="text-[10px] font-medium uppercase tracking-wide text-whatsapp-800 bg-whatsapp-100 px-1.5 py-0.5 rounded">
                    Em uso
                  </span>
                )}
              </div>
              <p className="text-[11px] text-gray-500">{slot.hint}</p>

              <div
                role="button"
                tabIndex={0}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault();
                    handlePick(slot.source);
                  }
                }}
                onDragOver={(e) => {
                  e.preventDefault();
                  e.stopPropagation();
                }}
                onDrop={(e) => {
                  e.preventDefault();
                  e.stopPropagation();
                  if (!isBusy && e.dataTransfer.files?.length) {
                    void uploadFiles(slot.source, e.dataTransfer.files);
                  }
                }}
                onClick={() => handlePick(slot.source)}
                className={`rounded-lg border-2 border-dashed border-gray-200 p-4 text-center cursor-pointer transition-all ${
                  isBusy ? 'opacity-60 pointer-events-none' : 'hover:border-whatsapp-400 hover:bg-white'
                }`}
              >
                {isBusy ? (
                  <Loader2 className="w-5 h-5 animate-spin text-whatsapp-600 mx-auto" />
                ) : (
                  <Upload className="w-5 h-5 text-gray-500 mx-auto" />
                )}
                <p className="text-[11px] font-medium text-gray-700 mt-2">
                  {isBusy ? 'Enviando…' : 'Arraste ou clique'}
                </p>
              </div>

              {snap ? (
                <p className="text-[11px] text-gray-600">
                  Último: <span className="font-medium text-gray-800">{snap.file_name}</span>
                  {' · '}
                  {snap.row_count.toLocaleString('pt-BR')} linhas
                  {' · '}
                  {fmtDt(snap.created_at)}
                </p>
              ) : (
                <p className="text-[11px] text-gray-400">Nenhum arquivo nesta fonte.</p>
              )}
            </div>
          );
        })}
      </div>

      <RematriculaSnapshotHistory
        snapshots={history}
        activeSnapshotId={status?.active_snapshot?.id ?? null}
        loading={historyLoading && !history.length}
      />
    </section>
  );
}
