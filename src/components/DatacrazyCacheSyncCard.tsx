import { useCallback, useEffect, useRef, useState } from 'react';
import { Database, RefreshCw } from 'lucide-react';
import {
  maintenanceApi,
  type DatacrazyCacheStatusResponse,
} from '../services/maintenanceApi';

function fmtDt(iso: string | null | undefined) {
  if (!iso) return '—';
  return new Date(iso).toLocaleString('pt-BR', {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

function fmtDurationMs(ms: number) {
  if (ms < 60_000) return `${Math.round(ms / 1000)} s`;
  return `${Math.floor(ms / 60_000)} min`;
}

export function DatacrazyCacheSyncCard() {
  const [status, setStatus] = useState<DatacrazyCacheStatusResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const pollRef = useRef<number | null>(null);

  const stopPoll = useCallback(() => {
    if (pollRef.current != null) {
      window.clearInterval(pollRef.current);
      pollRef.current = null;
    }
  }, []);

  const loadStatus = useCallback(async () => {
    try {
      const s = await maintenanceApi.getDatacrazyCacheStatus();
      setStatus(s);
      setError(null);
      return s;
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Falha ao carregar status do cache');
      return null;
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadStatus();
    return () => stopPoll();
  }, [loadStatus, stopPoll]);

  const startPolling = useCallback(() => {
    stopPoll();
    pollRef.current = window.setInterval(() => {
      void loadStatus();
    }, 4000) as unknown as number;
  }, [loadStatus, stopPoll]);

  useEffect(() => {
    if (status?.running) {
      startPolling();
    } else {
      stopPoll();
    }
  }, [status?.running, startPolling, stopPoll]);

  const handleSync = async () => {
    const ok = window.confirm(
      'Atualizar snapshot local do DataCrazy?\n\n' +
        'Varre todos os leads do CRM (CPF → lead_id) e grava no Postgres. ' +
        'Roda em segundo plano (~5–20 min conforme o tamanho da base). ' +
        'Recomendado antes de disparos em massa — depois use modo cache_only no servidor.'
    );
    if (!ok) return;
    setStarting(true);
    setError(null);
    try {
      await maintenanceApi.startDatacrazyCacheSync();
      await loadStatus();
      startPolling();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Falha ao iniciar sync');
    } finally {
      setStarting(false);
    }
  };

  const last = status?.last_sync;
  const lastDurationMs =
    last?.finished_at && last?.started_at
      ? new Date(last.finished_at).getTime() - new Date(last.started_at).getTime()
      : null;

  return (
    <div className="rounded-xl border border-sky-200 dark:border-sky-800/50 bg-sky-50/80 dark:bg-sky-950/30 px-4 py-3">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 text-sm font-semibold text-sky-900 dark:text-sky-100">
            <Database className="w-4 h-4 shrink-0 text-sky-600 dark:text-sky-400" />
            Snapshot DataCrazy (cache local)
          </div>
          <p className="text-xs text-sky-800/80 dark:text-sky-300/80 mt-1 max-w-2xl leading-relaxed">
            Índice CPF → lead_id no Postgres. O disparo consulta aqui antes da API — acelera
            rematrícula em massa. Sync automático à meia-noite (BRT); rode manual antes de campanhas
            grandes.
          </p>
          {loading && !status ? (
            <p className="text-xs text-sky-700/70 mt-2">Carregando…</p>
          ) : (
            <div className="mt-2 text-xs text-sky-900/90 dark:text-sky-200/90 space-y-0.5 tabular-nums">
              <p>
                <strong>{(status?.cache_count ?? 0).toLocaleString('pt-BR')}</strong> CPFs no cache
              </p>
              {status?.running ? (
                <p className="text-amber-700 dark:text-amber-300 font-medium">
                  Sync em andamento desde {fmtDt(status.running_since)}…
                </p>
              ) : last ? (
                <p>
                  Último sync: {fmtDt(last.finished_at || last.started_at)}
                  {last.status === 'ok' && lastDurationMs != null && lastDurationMs > 0
                    ? ` · ${fmtDurationMs(lastDurationMs)}`
                    : ''}
                  {last.status === 'ok'
                    ? ` · ${last.leads_upserted.toLocaleString('pt-BR')} gravados`
                    : last.status === 'error'
                      ? ` · erro: ${last.error_message || 'falhou'}`
                      : ''}
                </p>
              ) : (
                <p>Nenhum sync registrado ainda.</p>
              )}
            </div>
          )}
          {error && <p className="text-xs text-rose-600 dark:text-rose-400 mt-2">{error}</p>}
        </div>
        <div className="flex flex-wrap gap-2 shrink-0">
          <button
            type="button"
            onClick={() => void loadStatus()}
            disabled={loading || Boolean(status?.running)}
            className="inline-flex items-center gap-1.5 px-3 py-2 text-xs font-medium text-sky-800 dark:text-sky-200 bg-white dark:bg-slate-900 border border-sky-200 dark:border-sky-700 rounded-lg hover:bg-sky-50 dark:hover:bg-slate-800 disabled:opacity-50"
            title="Atualizar status"
          >
            <RefreshCw className={`w-3.5 h-3.5 ${loading ? 'animate-spin' : ''}`} />
            Atualizar
          </button>
          <button
            type="button"
            onClick={() => void handleSync()}
            disabled={starting || Boolean(status?.running)}
            className="inline-flex items-center gap-1.5 px-3 py-2 text-xs font-medium text-white bg-sky-600 hover:bg-sky-700 rounded-lg disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {starting || status?.running ? (
              <RefreshCw className="w-3.5 h-3.5 animate-spin" />
            ) : (
              <Database className="w-3.5 h-3.5" />
            )}
            {status?.running ? 'Sincronizando…' : 'Rodar sync agora'}
          </button>
        </div>
      </div>
    </div>
  );
}
