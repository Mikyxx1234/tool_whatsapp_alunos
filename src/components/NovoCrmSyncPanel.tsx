import { useCallback, useEffect, useRef, useState } from 'react';
import {
  AlertTriangle,
  CheckCircle2,
  CreditCard,
  Database,
  FileWarning,
  RefreshCw,
  UserRound,
  X,
} from 'lucide-react';
import {
  maintenanceApi,
  type NovoCrmCacheStatusResponse,
  type NovoCrmEnrichPreviewResponse,
  type NovoCrmEnrichScope,
  type NovoCrmRegressionEvent,
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

type TileId = 'cache' | 'cpf' | 'rgm' | 'incomplete' | 'sync' | 'alerts';

type PreviewState = {
  tile: TileId;
  scope?: NovoCrmEnrichScope;
  loading: boolean;
  error: string | null;
  data: NovoCrmEnrichPreviewResponse | null;
  syncNote?: string | null;
  alerts?: NovoCrmRegressionEvent[] | null;
};

export function NovoCrmSyncPanel() {
  const [status, setStatus] = useState<NovoCrmCacheStatusResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [preview, setPreview] = useState<PreviewState | null>(null);
  const [applying, setApplying] = useState(false);
  const [enrichJobId, setEnrichJobId] = useState<string | null>(null);
  const [enrichMsg, setEnrichMsg] = useState<string | null>(null);
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
      setError(e instanceof Error ? e.message : 'Falha ao carregar status');
      return null;
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadStatus();
    return () => stopPoll();
  }, [loadStatus, stopPoll]);

  useEffect(() => {
    if (status?.running || enrichJobId) {
      stopPoll();
      pollRef.current = window.setInterval(() => {
        void loadStatus();
        if (enrichJobId) {
          void maintenanceApi
            .getNovoCrmEnrichStatus(enrichJobId)
            .then((r) => {
              if (!r.job) return;
              setEnrichMsg(r.job.status_message || r.job.phase || null);
              if (r.job.status !== 'running') {
                setEnrichJobId(null);
                setApplying(false);
                if (r.job.status === 'completed') {
                  setEnrichMsg(
                    `Concluído: ${r.job.result?.updated ?? r.job.sent ?? 0} atualizados` +
                      (r.job.result?.errors ? `, ${r.job.result.errors} erros` : '')
                  );
                } else if (r.job.status === 'failed') {
                  setEnrichMsg(r.job.error || 'Enriquecimento falhou');
                }
                void loadStatus();
              }
            })
            .catch(() => {});
        }
      }, 3000) as unknown as number;
    } else {
      stopPoll();
    }
    return () => stopPoll();
  }, [status?.running, enrichJobId, loadStatus, stopPoll]);

  const last = status?.last_sync || null;
  const lastDurationMs =
    last?.finished_at && last?.started_at
      ? new Date(last.finished_at).getTime() - new Date(last.started_at).getTime()
      : null;

  const openEnrichPreview = async (tile: TileId, scope: NovoCrmEnrichScope) => {
    if (
      !window.confirm(
        'Gerar prévia (dry-run) desta atualização?\n\nNada será gravado no CRM ainda.'
      )
    ) {
      return;
    }
    setPreview({ tile, scope, loading: true, error: null, data: null });
    try {
      const data = await maintenanceApi.previewNovoCrmEnrich(scope);
      setPreview({ tile, scope, loading: false, error: null, data });
    } catch (e) {
      setPreview({
        tile,
        scope,
        loading: false,
        error: e instanceof Error ? e.message : 'Falha na prévia',
        data: null,
      });
    }
  };

  const openSyncPreview = () => {
    if (
      !window.confirm(
        'Prévia do sync full do espelho local?\n\nNo próximo passo você confirma para iniciar a sincronização (não grava campos no CRM — só atualiza o cache local).'
      )
    ) {
      return;
    }
    setPreview({
      tile: 'sync',
      loading: false,
      error: null,
      data: null,
      syncNote:
        'Vai varrer contacts/deals do CRM EduIT e atualizar o Postgres local. É lento de propósito (~minutos a ~1h). A ativação por tag usa este cache.',
    });
  };

  const openAlertsPreview = async () => {
    if (!window.confirm('Carregar alertas de perda de dados?')) return;
    setPreview({ tile: 'alerts', loading: true, error: null, data: null, alerts: null });
    try {
      const r = await maintenanceApi.listNovoCrmRegressions({ limit: 50 });
      setPreview({
        tile: 'alerts',
        loading: false,
        error: null,
        data: null,
        alerts: r.events || [],
      });
    } catch (e) {
      setPreview({
        tile: 'alerts',
        loading: false,
        error: e instanceof Error ? e.message : 'Falha ao listar alertas',
        data: null,
        alerts: null,
      });
    }
  };

  const handleTileClick = (tile: TileId) => {
    if (tile === 'cache') {
      void loadStatus();
      return;
    }
    if (tile === 'sync') {
      openSyncPreview();
      return;
    }
    if (tile === 'alerts') {
      void openAlertsPreview();
      return;
    }
    const scope: NovoCrmEnrichScope =
      tile === 'cpf' ? 'cpf' : tile === 'rgm' ? 'rgm' : 'incomplete';
    void openEnrichPreview(tile, scope);
  };

  const applyPreview = async () => {
    if (!preview) return;

    if (preview.tile === 'sync') {
      if (
        !window.confirm(
          'Confirmar: iniciar sync full do cache local agora?\n\nNão altera campos no CRM — só o espelho local.'
        )
      ) {
        return;
      }
      setApplying(true);
      try {
        await maintenanceApi.startNovoCrmCacheSync({ mode: 'full' });
        setPreview(null);
        setEnrichMsg('Sync full iniciado…');
        await loadStatus();
      } catch (e) {
        const msg = e instanceof Error ? e.message : 'Falha ao iniciar sync';
        if (/já em andamento/i.test(msg)) {
          setPreview(null);
          await loadStatus();
        } else {
          setError(msg);
        }
      } finally {
        setApplying(false);
      }
      return;
    }

    if (preview.tile === 'alerts') {
      setPreview(null);
      return;
    }

    if (!preview.scope || !preview.data) return;
    const n = preview.data.would_update;
    if (
      !window.confirm(
        `Confirmar gravação no Novo CRM?\n\n` +
          `${n.toLocaleString('pt-BR')} negócio(s) terão campos vazios preenchidos a partir de matriculados.\n` +
          `Campos já preenchidos NÃO serão sobrescritos.`
      )
    ) {
      return;
    }
    setApplying(true);
    try {
      const started = await maintenanceApi.startNovoCrmEnrichApply(preview.scope);
      setEnrichJobId(started.jobId);
      setEnrichMsg('Enriquecimento em andamento…');
      setPreview(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Falha ao iniciar enriquecimento');
      setApplying(false);
    }
  };

  const running = status?.running_sync || null;
  const total = running?.contacts_total ?? null;
  const seen = running?.contacts_seen ?? 0;
  const pct =
    total && total > 0 ? Math.min(100, Math.round((seen / total) * 100)) : null;

  const tiles: Array<{
    id: TileId;
    label: string;
    value: string;
    hint: string;
    icon: typeof Database;
    accent: string;
  }> = [
    {
      id: 'cache',
      label: 'Pessoas no cache',
      value: (status?.cache_active ?? 0).toLocaleString('pt-BR'),
      hint: 'Clique para atualizar o status',
      icon: UserRound,
      accent: 'border-slate-200 bg-slate-50 hover:border-slate-300',
    },
    {
      id: 'cpf',
      label: 'Sem CPF',
      value: (status?.missing_cpf ?? 0).toLocaleString('pt-BR'),
      hint: 'Prévia → preencher CPF vazio',
      icon: CreditCard,
      accent: 'border-amber-200 bg-amber-50 hover:border-amber-300',
    },
    {
      id: 'rgm',
      label: 'Sem RGM',
      value: (status?.missing_rgm ?? 0).toLocaleString('pt-BR'),
      hint: 'Prévia → preencher RGM vazio',
      icon: CreditCard,
      accent: 'border-orange-200 bg-orange-50 hover:border-orange-300',
    },
    {
      id: 'incomplete',
      label: 'Campos incompletos',
      value: (status?.incomplete_fields ?? 0).toLocaleString('pt-BR'),
      hint: 'Prévia → 10 campos mapeados',
      icon: FileWarning,
      accent: 'border-rose-200 bg-rose-50 hover:border-rose-300',
    },
    {
      id: 'sync',
      label: 'Último sync',
      value: last
        ? last.status === 'ok'
          ? fmtDt(last.finished_at || last.started_at)
          : last.status
        : 'Nunca',
      hint: lastDurationMs
        ? `${last?.mode || 'full'} · ${fmtDurationMs(lastDurationMs)} · ou use o botão acima`
        : 'Ou use «Rodar sync agora» no topo',
      icon: Database,
      accent: 'border-indigo-200 bg-indigo-50 hover:border-indigo-300',
    },
    {
      id: 'alerts',
      label: 'Alertas',
      value: (status?.open_data_loss_events ?? 0).toLocaleString('pt-BR'),
      hint: 'Regressões de campos no cache',
      icon: AlertTriangle,
      accent:
        (status?.open_data_loss_events ?? 0) > 0
          ? 'border-amber-300 bg-amber-50 hover:border-amber-400'
          : 'border-emerald-200 bg-emerald-50 hover:border-emerald-300',
    },
  ];

  return (
    <div className="space-y-6">
      <div className="bg-white rounded-2xl border border-gray-100 shadow-sm p-4 sm:p-6">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h2 className="text-base font-semibold text-gray-900">Sync Novo CRM</h2>
            <p className="text-sm text-gray-500 mt-1 max-w-3xl">
              Espelho local de contacts/deals. Clique num quadro para ver a{' '}
              <strong>prévia</strong>; confirme de novo para aplicar (só campos vazios, a partir
              do relatório de matriculados).
            </p>
          </div>
          <div className="flex flex-wrap gap-2 shrink-0">
            <button
              type="button"
              onClick={() => void loadStatus()}
              disabled={loading}
              className="inline-flex items-center gap-1.5 px-3 py-2 text-xs font-medium text-gray-700 bg-white border border-gray-200 rounded-lg hover:bg-gray-50 disabled:opacity-50"
            >
              <RefreshCw className={`w-3.5 h-3.5 ${loading ? 'animate-spin' : ''}`} />
              Atualizar status
            </button>
            <button
              type="button"
              onClick={() => openSyncPreview()}
              disabled={Boolean(status?.running) || applying}
              className="inline-flex items-center gap-1.5 px-3 py-2 text-xs font-medium text-white bg-indigo-600 hover:bg-indigo-700 rounded-lg disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {status?.running ? (
                <RefreshCw className="w-3.5 h-3.5 animate-spin" />
              ) : (
                <Database className="w-3.5 h-3.5" />
              )}
              {status?.running ? 'Sincronizando…' : 'Rodar sync agora'}
            </button>
          </div>
        </div>

        {error && <p className="mt-3 text-sm text-rose-600">{error}</p>}
        {enrichMsg && (
          <p className="mt-3 text-sm text-indigo-700 flex items-center gap-2">
            <CheckCircle2 className="w-4 h-4 shrink-0" />
            {enrichMsg}
          </p>
        )}

        {status?.running && (
          <div className="mt-4 max-w-lg">
            <p className="text-xs font-medium text-amber-700 mb-1">
              Sync {running?.mode || 'full'} em andamento…
            </p>
            <div className="h-2 w-full overflow-hidden rounded-full bg-indigo-100">
              <div
                className={`h-full rounded-full bg-indigo-600 transition-[width] duration-500 ${
                  pct == null ? 'animate-pulse w-1/3' : ''
                }`}
                style={pct == null ? undefined : { width: `${pct}%` }}
              />
            </div>
            <p className="mt-1 text-[11px] text-gray-500 tabular-nums">
              {pct != null
                ? `${pct}% · ${seen.toLocaleString('pt-BR')} de ${(total ?? 0).toLocaleString('pt-BR')}`
                : `${seen.toLocaleString('pt-BR')} processados…`}
            </p>
          </div>
        )}

        <div className="mt-5 grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
          {tiles.map((t) => {
            const Icon = t.icon;
            return (
              <button
                key={t.id}
                type="button"
                onClick={() => handleTileClick(t.id)}
                className={`text-left rounded-xl border p-4 transition-all ${t.accent}`}
              >
                <div className="flex items-start gap-3">
                  <div className="w-9 h-9 rounded-lg bg-white/80 border border-black/5 flex items-center justify-center shrink-0">
                    <Icon className="w-4 h-4 text-gray-700" />
                  </div>
                  <div className="min-w-0">
                    <p className="text-xs font-medium text-gray-500">{t.label}</p>
                    <p className="text-xl font-semibold text-gray-900 tabular-nums mt-0.5 truncate">
                      {loading && !status ? '…' : t.value}
                    </p>
                    <p className="text-[11px] text-gray-500 mt-1">{t.hint}</p>
                  </div>
                </div>
              </button>
            );
          })}
        </div>
      </div>

      {preview && (
        <div className="fixed inset-0 z-50 flex items-start justify-center p-4 sm:p-8 bg-black/40 overflow-y-auto">
          <div className="w-full max-w-lg bg-white rounded-2xl shadow-xl border border-gray-100 my-8">
            <div className="flex items-center justify-between px-5 py-4 border-b border-gray-100">
              <h3 className="text-sm font-semibold text-gray-900">
                {preview.tile === 'sync'
                  ? 'Prévia — Sync full'
                  : preview.tile === 'alerts'
                    ? 'Alertas de perda de dados'
                    : `Prévia — ${preview.scope}`}
              </h3>
              <button
                type="button"
                onClick={() => setPreview(null)}
                className="p-1 rounded-lg text-gray-400 hover:bg-gray-100"
              >
                <X className="w-4 h-4" />
              </button>
            </div>
            <div className="px-5 py-4 text-sm text-gray-700 space-y-3 max-h-[60vh] overflow-y-auto">
              {preview.loading && <p className="text-gray-500">Calculando prévia…</p>}
              {preview.error && <p className="text-rose-600">{preview.error}</p>}
              {preview.syncNote && <p>{preview.syncNote}</p>}
              {preview.alerts && (
                <div className="space-y-2">
                  {preview.alerts.length === 0 ? (
                    <p className="text-emerald-700">Nenhum alerta aberto.</p>
                  ) : (
                    preview.alerts.map((ev) => (
                      <div
                        key={String(ev.id)}
                        className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs"
                      >
                        <p className="font-medium">#{ev.id} · {ev.contact_id || '—'}</p>
                        <p className="text-gray-500 mt-0.5">{fmtDt(ev.detected_at)}</p>
                        <button
                          type="button"
                          className="mt-2 text-indigo-700 font-medium hover:underline"
                          onClick={() =>
                            void maintenanceApi.ackNovoCrmRegression(ev.id).then(() => {
                              void openAlertsPreview();
                              void loadStatus();
                            })
                          }
                        >
                          Marcar como visto
                        </button>
                      </div>
                    ))
                  )}
                </div>
              )}
              {preview.data && (
                <>
                  <p>
                    Candidatos: <strong>{preview.data.candidates.toLocaleString('pt-BR')}</strong>
                    {' · '}Match matriculados:{' '}
                    <strong>{preview.data.matched.toLocaleString('pt-BR')}</strong>
                    {' · '}Sem match:{' '}
                    <strong>{preview.data.no_match.toLocaleString('pt-BR')}</strong>
                  </p>
                  <p>
                    Seriam atualizados:{' '}
                    <strong className="text-indigo-700">
                      {preview.data.would_update.toLocaleString('pt-BR')}
                    </strong>
                    {' · '}Sem fill útil:{' '}
                    {preview.data.skipped_no_fill.toLocaleString('pt-BR')}
                  </p>
                  <div>
                    <p className="text-xs font-medium text-gray-500 mb-1">Por campo</p>
                    <ul className="text-xs space-y-0.5 tabular-nums">
                      {Object.entries(preview.data.would_fill_by_field)
                        .filter(([, n]) => n > 0)
                        .map(([k, n]) => (
                          <li key={k}>
                            {k}: {n.toLocaleString('pt-BR')}
                          </li>
                        ))}
                    </ul>
                  </div>
                  {preview.data.sample?.length > 0 && (
                    <div>
                      <p className="text-xs font-medium text-gray-500 mb-1">Amostra</p>
                      <ul className="text-xs space-y-1">
                        {preview.data.sample.slice(0, 8).map((s) => (
                          <li key={s.contact_id} className="truncate">
                            {s.nome || s.contact_id}: {s.fields.join(', ')}
                          </li>
                        ))}
                      </ul>
                    </div>
                  )}
                  <p className="text-[11px] text-gray-400">
                    Fonte: {preview.data.matriculados_file || preview.data.matriculados_snapshot_id}
                  </p>
                </>
              )}
            </div>
            <div className="px-5 py-4 border-t border-gray-100 flex flex-wrap justify-end gap-2">
              <button
                type="button"
                onClick={() => setPreview(null)}
                className="px-3 py-2 text-xs font-medium text-gray-700 border border-gray-200 rounded-lg hover:bg-gray-50"
              >
                Fechar
              </button>
              {preview.tile !== 'alerts' && !preview.loading && !preview.error && (
                <button
                  type="button"
                  disabled={applying || (preview.data != null && preview.data.would_update === 0)}
                  onClick={() => void applyPreview()}
                  className="px-3 py-2 text-xs font-medium text-white bg-indigo-600 hover:bg-indigo-700 rounded-lg disabled:opacity-50"
                >
                  {applying
                    ? 'Aplicando…'
                    : preview.tile === 'sync'
                      ? 'Confirmar sync'
                      : 'Confirmar gravação'}
                </button>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
