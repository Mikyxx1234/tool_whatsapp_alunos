import { useCallback, useEffect, useRef, useState } from 'react';
import { Database, RefreshCw } from 'lucide-react';
import {
  maintenanceApi,
  type NovoCrmCacheStatusResponse,
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

export function NovoCrmCacheSyncCard() {
  const [status, setStatus] = useState<NovoCrmCacheStatusResponse | null>(null);
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
      const s = await maintenanceApi.getNovoCrmCacheStatus();
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
    }, 3000) as unknown as number;
  }, [loadStatus, stopPoll]);

  useEffect(() => {
    if (status?.running) startPolling();
    else stopPoll();
  }, [status?.running, startPolling, stopPoll]);

  const handleSync = async () => {
    const ok = window.confirm(
      'Atualizar o espelho local do Novo CRM (full)?\n\n' +
        'Varre contacts/deals do CRM EduIT e grava no Postgres local. ' +
        'Roda em segundo plano e é intencionalmente lento (~1h) para não pesar no CRM. ' +
        'Pode acompanhar a barra de progresso aqui.'
    );
    if (!ok) return;
    setStarting(true);
    setError(null);
    try {
      await maintenanceApi.startNovoCrmCacheSync({ mode: 'full' });
      await loadStatus();
      startPolling();
    } catch (e) {
      const msg = e instanceof Error ? e.message : 'Falha ao iniciar sync';
      // Se já está rodando, trata como sucesso e acompanha progresso.
      if (/já em andamento/i.test(msg)) {
        await loadStatus();
        startPolling();
      } else {
        setError(msg);
      }
    } finally {
      setStarting(false);
    }
  };

  const running = status?.running_sync || null;
  const last = status?.last_sync || null;
  const lastDurationMs =
    last?.finished_at && last?.started_at
      ? new Date(last.finished_at).getTime() - new Date(last.started_at).getTime()
      : null;

  const total = running?.contacts_total ?? null;
  const seen = running?.contacts_seen ?? 0;
  const pct =
    total && total > 0 ? Math.min(100, Math.round((seen / total) * 100)) : null;
  const indeterminate = Boolean(status?.running) && pct == null;

  return (
    <div className="rounded-xl border border-indigo-200 dark:border-indigo-800/50 bg-indigo-50/80 dark:bg-indigo-950/30 px-4 py-3">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 text-sm font-semibold text-indigo-900 dark:text-indigo-100">
            <Database className="w-4 h-4 shrink-0 text-indigo-600 dark:text-indigo-400" />
            Espelho local do Novo CRM
          </div>
          <p className="text-xs text-indigo-800/80 dark:text-indigo-300/80 mt-1 max-w-2xl leading-relaxed">
            Cache de contacts/deals do CRM EduIT. A ativação por tag consulta aqui antes da API.
            Full automático de madrugada (lento de propósito); rode manual quando precisar de dados
            frescos.
          </p>
          {loading && !status ? (
            <p className="text-xs text-indigo-700/70 mt-2">Carregando…</p>
          ) : (
            <div className="mt-2 text-xs text-indigo-900/90 dark:text-indigo-200/90 space-y-0.5 tabular-nums">
              <p>
                <strong>{(status?.cache_active ?? 0).toLocaleString('pt-BR')}</strong> pessoas no
                cache
                {status && status.open_data_loss_events > 0 ? (
                  <span className="text-amber-700 dark:text-amber-300">
                    {' '}
                    · {status.open_data_loss_events} alerta(s) de perda de dados
                  </span>
                ) : null}
              </p>
              {status?.running ? (
                <p className="text-amber-700 dark:text-amber-300 font-medium">
                  Sync {running?.mode === 'incremental' ? 'incremental' : 'full'} em andamento
                  {running?.started_at ? ` desde ${fmtDt(running.started_at)}` : ''}…
                </p>
              ) : last ? (
                <p>
                  Último sync ({last.mode}): {fmtDt(last.finished_at || last.started_at)}
                  {last.status === 'ok' && lastDurationMs != null && lastDurationMs > 0
                    ? ` · ${fmtDurationMs(lastDurationMs)}`
                    : ''}
                  {last.status === 'ok'
                    ? ` · ${last.cache_upserted.toLocaleString('pt-BR')} atualizados`
                    : last.status === 'error'
                      ? ` · erro: ${last.error_message || 'falhou'}`
                      : ''}
                </p>
              ) : (
                <p>Nenhum sync registrado ainda.</p>
              )}
            </div>
          )}

          {status?.running && (
            <div className="mt-3 max-w-md">
              <div className="h-2 w-full overflow-hidden rounded-full bg-indigo-200/70 dark:bg-indigo-900/50">
                <div
                  className={`h-full rounded-full bg-indigo-600 dark:bg-indigo-500 transition-[width] duration-500 ${
                    indeterminate ? 'animate-pulse w-1/3' : ''
                  }`}
                  style={indeterminate ? undefined : { width: `${pct ?? 0}%` }}
                />
              </div>
              <p className="mt-1 text-[11px] text-indigo-800/80 dark:text-indigo-300/80 tabular-nums">
                {pct != null
                  ? `${pct}% · ${seen.toLocaleString('pt-BR')} de ${(total ?? 0).toLocaleString('pt-BR')} contacts`
                  : `${seen.toLocaleString('pt-BR')} contacts processados…`}
              </p>
            </div>
          )}

          {error && <p className="text-xs text-rose-600 dark:text-rose-400 mt-2">{error}</p>}
        </div>
        <div className="flex flex-wrap gap-2 shrink-0">
          <button
            type="button"
            onClick={() => void loadStatus()}
            disabled={loading}
            className="inline-flex items-center gap-1.5 px-3 py-2 text-xs font-medium text-indigo-800 dark:text-indigo-200 bg-white dark:bg-slate-900 border border-indigo-200 dark:border-indigo-700 rounded-lg hover:bg-indigo-50 dark:hover:bg-slate-800 disabled:opacity-50"
            title="Atualizar status"
          >
            <RefreshCw className={`w-3.5 h-3.5 ${loading ? 'animate-spin' : ''}`} />
            Atualizar
          </button>
          <button
            type="button"
            onClick={() => void handleSync()}
            disabled={starting || Boolean(status?.running)}
            className="inline-flex items-center gap-1.5 px-3 py-2 text-xs font-medium text-white bg-indigo-600 hover:bg-indigo-700 rounded-lg disabled:opacity-50 disabled:cursor-not-allowed"
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
