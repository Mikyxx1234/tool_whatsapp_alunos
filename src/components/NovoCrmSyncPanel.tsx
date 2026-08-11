import { useCallback, useEffect, useRef, useState } from 'react';
import {
  AlertTriangle,
  CheckCircle2,
  CreditCard,
  Database,
  FileWarning,
  RefreshCw,
  Square,
  UserRound,
  X,
} from 'lucide-react';
import {
  maintenanceApi,
  type NovoCrmCacheStatusResponse,
  type NovoCrmFlagsStageJobStatusResponse,
  type NovoCrmRegressionEvent,
  type OrphanDedupePreviewResponse,
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
  if (!Number.isFinite(ms) || ms < 0) return '—';
  if (ms < 60_000) return `${Math.round(ms / 1000)} s`;
  const m = Math.floor(ms / 60_000);
  const s = Math.round((ms % 60_000) / 1000);
  if (m < 60) return s > 0 ? `${m} min ${s} s` : `${m} min`;
  const h = Math.floor(m / 60);
  return `${h} h ${m % 60} min`;
}

function phaseLabel(phase: string | null | undefined) {
  switch (phase) {
    case 'starting':
      return 'Iniciando';
    case 'loading_bases':
      return 'Carregando bases SIAA';
    case 'loading_cache':
      return 'Carregando espelho';
    case 'processing':
      return 'Calculando alterações';
    case 'processing_exit':
      return 'Entrada/saída remat';
    case 'writing':
      return 'Gravando no CRM';
    case 'done':
      return 'Concluído';
    default:
      return phase || '…';
  }
}

type AlertsPreview = {
  loading: boolean;
  error: string | null;
  alerts: NovoCrmRegressionEvent[] | null;
};

type FlagsJobLive = NonNullable<NovoCrmFlagsStageJobStatusResponse['job']>;

export function NovoCrmSyncPanel() {
  const [status, setStatus] = useState<NovoCrmCacheStatusResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [alertsPreview, setAlertsPreview] = useState<AlertsPreview | null>(null);

  const [syncBusy, setSyncBusy] = useState(false);
  const [syncMsg, setSyncMsg] = useState<string | null>(null);
  const [syncStopping, setSyncStopping] = useState(false);

  const [flagsJobId, setFlagsJobId] = useState<string | null>(null);
  const [flagsJob, setFlagsJob] = useState<FlagsJobLive | null>(null);
  const [flagsMsg, setFlagsMsg] = useState<string | null>(null);
  const [flagsBusy, setFlagsBusy] = useState(false);
  const [flagsStopping, setFlagsStopping] = useState(false);

  const [dedupeBusy, setDedupeBusy] = useState(false);
  const [dedupeMsg, setDedupeMsg] = useState<string | null>(null);
  const [dedupePreview, setDedupePreview] = useState<OrphanDedupePreviewResponse | null>(null);
  const [dedupeJobId, setDedupeJobId] = useState<string | null>(null);
  const [dedupeMode, setDedupeMode] = useState<'preview' | 'apply'>('preview');
  const [dedupeApplied, setDedupeApplied] = useState(false);

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
      // Reanexa Att em andamento (refresh / outra aba).
      if (s.running_flags?.jobId) {
        setFlagsJobId((prev) => prev || s.running_flags!.jobId);
        setFlagsBusy(true);
        const r = s.running_flags;
        setFlagsJob({
          jobId: r.jobId,
          mode: r.mode || 'flags_stage',
          status: r.status,
          dry_run: Boolean(r.dry_run),
          total: r.total ?? 0,
          processed: r.processed ?? 0,
          sent: r.sent ?? 0,
          matched: r.matched ?? 0,
          flags_updated: r.flags_updated ?? 0,
          stages_moved: r.stages_moved ?? 0,
          eta_ms: r.eta_ms ?? null,
          phase: r.phase,
          status_message: r.status_message,
          started_at: r.started_at,
          finished_at: null,
          cancel_requested: r.cancel_requested,
          error: null,
          result: null,
        });
      }
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
    const needPoll = Boolean(status?.running || flagsJobId || dedupeJobId);
    if (needPoll) {
      stopPoll();
      pollRef.current = window.setInterval(() => {
        void loadStatus();
        if (flagsJobId) {
          void maintenanceApi
            .getNovoCrmFlagsStageStatus(flagsJobId)
            .then((r) => {
              if (!r.job) return;
              setFlagsJob(r.job);
              setFlagsMsg(r.job.status_message || phaseLabel(r.job.phase));
              if (r.job.status !== 'running') {
                setFlagsJobId(null);
                setFlagsBusy(false);
                setFlagsStopping(false);
                const res = r.job.result;
                if (r.job.status === 'completed') {
                  setFlagsMsg(
                    `Att concluída: ${res?.flags_updated ?? r.job.flags_updated ?? 0} flags · ${
                      res?.stages_moved ?? r.job.stages_moved ?? 0
                    } etapas` +
                      (res?.stages_skipped_untouchable
                        ? ` · ${res.stages_skipped_untouchable} intocáveis`
                        : '') +
                      (res?.scanned != null
                        ? ` · ${res.scanned.toLocaleString('pt-BR')} deals`
                        : '') +
                      (res?.errors ? ` · ${res.errors} erros` : '')
                  );
                } else if (r.job.status === 'cancelled') {
                  setFlagsMsg(
                    `Att cancelada` +
                      (res
                        ? ` (até então: ${res.flags_updated ?? 0} flags · ${res.stages_moved ?? 0} etapas · ${res.scanned ?? 0} deals)`
                        : '')
                  );
                } else if (r.job.status === 'failed') {
                  setFlagsMsg(r.job.error || 'Att de etapas falhou');
                }
                void loadStatus();
              }
            })
            .catch(() => {});
        }
        if (dedupeJobId) {
          void maintenanceApi
            .getOrphanDedupeStatus(dedupeJobId)
            .then((r) => {
              if (!r.job) return;
              setDedupeMsg(r.job.status_message || r.job.phase || null);
              if (r.job.status !== 'running') {
                setDedupeJobId(null);
                setDedupeBusy(false);
                if (r.job.status === 'completed' && r.job.result) {
                  setDedupePreview(r.job.result);
                  setDedupeApplied(!r.job.result.dry_run);
                  setDedupeMsg(null);
                } else if (r.job.status === 'failed') {
                  setDedupeMsg(
                    r.job.error || (dedupeMode === 'apply' ? 'Dedupe falhou' : 'Prévia dedupe falhou')
                  );
                }
                void loadStatus();
              }
            })
            .catch(() => {});
        }
      }, 2000) as unknown as number;
    } else {
      stopPoll();
    }
    return () => stopPoll();
  }, [status?.running, flagsJobId, dedupeJobId, dedupeMode, loadStatus, stopPoll]);

  const last = status?.last_sync || null;
  const lastFlags = status?.last_flags_sync || null;
  const lastDurationMs =
    last?.finished_at && last?.started_at
      ? new Date(last.finished_at).getTime() - new Date(last.started_at).getTime()
      : null;

  const openAlertsPreview = async () => {
    if (!window.confirm('Carregar alertas de perda de dados?')) return;
    setAlertsPreview({ loading: true, error: null, alerts: null });
    try {
      const r = await maintenanceApi.listNovoCrmRegressions({ limit: 50 });
      setAlertsPreview({
        loading: false,
        error: null,
        alerts: r.events || [],
      });
    } catch (e) {
      setAlertsPreview({
        loading: false,
        error: e instanceof Error ? e.message : 'Falha ao listar alertas',
        alerts: null,
      });
    }
  };

  const runFullSync = async () => {
    if (syncBusy || status?.running) return;
    const ok = window.confirm(
      'Full Sync — espelho local\n\n' +
        'Vai varrer contacts/deals do CRM e atualizar o Postgres local.\n' +
        'Não cria leads nem altera campos/etapas no CRM.\n' +
        'Pode demorar vários minutos (às vezes ~1h).\n\n' +
        'Confirmar?'
    );
    if (!ok) return;
    setSyncBusy(true);
    setSyncMsg('Iniciando Full Sync…');
    try {
      await maintenanceApi.startNovoCrmCacheSync({ mode: 'full' });
      setSyncMsg('Full Sync em andamento…');
      await loadStatus();
    } catch (e) {
      const msg = e instanceof Error ? e.message : 'Falha ao iniciar sync';
      if (/já em andamento/i.test(msg)) {
        setSyncMsg('Sync já em andamento.');
        await loadStatus();
      } else {
        setError(msg);
        setSyncMsg(null);
      }
    } finally {
      setSyncBusy(false);
    }
  };

  const stopFullSync = async () => {
    if (syncStopping) return;
    if (!window.confirm('Interromper o Full Sync? O espelho fica parcial (sem markDeleted).')) return;
    setSyncStopping(true);
    try {
      await maintenanceApi.stopNovoCrmCacheSync();
      setSyncMsg('Cancelando Full Sync… (para no próximo lote)');
    } catch (e) {
      setSyncMsg(e instanceof Error ? e.message : 'Falha ao pedir cancelamento');
    } finally {
      setSyncStopping(false);
    }
  };

  const runFlagsStageSync = async () => {
    if (flagsBusy || flagsJobId) return;
    const lf = status?.last_flags_sync;
    const lastLine = lf?.finished_at
      ? `Última Att real: ${fmtDt(lf.finished_at)} · ` +
        `${Number(lf.scanned || 0).toLocaleString('pt-BR')} deals · ` +
        `${Number(lf.matched || 0).toLocaleString('pt-BR')} match · ` +
        `${Number(lf.flags_updated || 0).toLocaleString('pt-BR')} flags · ` +
        `${Number(lf.stages_moved || 0).toLocaleString('pt-BR')} etapas` +
        (lf.cancelled ? ' · cancelada' : lf.aborted || lf.ok === false ? ' · incompleta' : '')
      : 'Ainda não há Att aplicada registrada neste ambiente.';

    const ok = window.confirm(
      `Att de etapas — aplicar no CRM\n\n` +
        `${lastLine}\n\n` +
        `Roda em TODOS os deals do espelho (sem amostra seca de 2.000).\n` +
        `Flags (Doc, Financeiro, BB, Evasão…) + etapa. CAA→Retenção só ≤72h; depois SIAA/Perdido.\n` +
        `Não toca Ganho/Cancelado nem Retenção manual (sem CAA open).\n` +
        `Acompanhe a barra de progresso e use "Parar" se precisar.\n\n` +
        `Dica: rode Full Sync antes se criou gente recentemente.\n\n` +
        `Confirmar aplicação?`
    );
    if (!ok) {
      setFlagsMsg('Cancelado.');
      return;
    }
    setFlagsBusy(true);
    setFlagsJob(null);
    setFlagsMsg('Iniciando Att de etapas…');
    try {
      const started = await maintenanceApi.startNovoCrmFlagsStage({ mode: 'flags_stage' });
      setFlagsJobId(started.jobId);
      setFlagsMsg('Att de etapas em andamento…');
    } catch (e) {
      setFlagsMsg(e instanceof Error ? e.message : 'Falha no Att de etapas');
      setFlagsBusy(false);
    }
  };

  const stopFlagsStage = async () => {
    if (flagsStopping) return;
    if (!window.confirm('Interromper a Att de etapas? O que já gravou permanece.')) return;
    setFlagsStopping(true);
    try {
      await maintenanceApi.stopNovoCrmFlagsStage(flagsJobId || undefined);
      setFlagsMsg('Cancelando Att… (para no próximo lote)');
    } catch (e) {
      setFlagsMsg(e instanceof Error ? e.message : 'Falha ao pedir cancelamento');
      setFlagsStopping(false);
    }
  };

  const runDedupePreview = async () => {
    if (dedupeBusy || dedupeJobId) return;
    setDedupeBusy(true);
    setDedupeMode('preview');
    setDedupeApplied(false);
    setDedupeMsg('Conferindo cada órfão ao vivo no CRM… (leva alguns minutos)');
    setDedupePreview(null);
    try {
      const started = await maintenanceApi.startOrphanDedupePreview({ scope: 'both' });
      setDedupeJobId(started.jobId);
    } catch (e) {
      setDedupeBusy(false);
      setDedupeMsg(e instanceof Error ? e.message : 'Falha na prévia dedupe');
    }
  };

  const confirmDedupeApply = async () => {
    if (dedupeBusy || dedupeJobId) return;
    setDedupeBusy(true);
    setDedupeMode('apply');
    setDedupeApplied(false);
    setDedupeMsg('Aplicando no CRM… (confere cada registro ao vivo antes de escrever)');
    setDedupePreview(null);
    try {
      const started = await maintenanceApi.startOrphanDedupe({ scope: 'both' });
      setDedupeJobId(started.jobId);
    } catch (e) {
      setDedupeBusy(false);
      setDedupeMsg(e instanceof Error ? e.message : 'Falha ao aplicar dedupe');
    }
  };

  const dismissDedupePreview = () => {
    setDedupePreview(null);
    setDedupeApplied(false);
    setDedupeMsg(null);
  };

  const running = status?.running_sync || null;
  const total = running?.contacts_total ?? null;
  const seen = running?.contacts_seen ?? 0;
  const pct =
    total && total > 0 ? Math.min(100, Math.round((seen / total) * 100)) : null;

  const flagsRunning = Boolean(flagsJobId) || Boolean(status?.running_flags);
  const fj = flagsJob;
  const flagsPct =
    fj && fj.total > 0
      ? Math.min(100, Math.round((fj.processed / fj.total) * 100))
      : fj && fj.phase === 'writing'
        ? 0
        : null;
  const flagsEta =
    fj?.eta_ms != null && fj.eta_ms > 0 ? fmtDurationMs(fj.eta_ms) : null;
  const flagsElapsed =
    fj?.started_at != null
      ? fmtDurationMs(Date.now() - new Date(fj.started_at).getTime())
      : null;

  const tiles: Array<{
    id: string;
    label: string;
    value: string;
    hint: string;
    icon: typeof Database;
    accent: string;
    onClick?: () => void;
  }> = [
    {
      id: 'cache',
      label: 'Pessoas no cache',
      value: (status?.cache_active ?? 0).toLocaleString('pt-BR'),
      hint: 'Espelho local (somente leitura)',
      icon: UserRound,
      accent: 'border-slate-200 bg-slate-50',
      onClick: () => void loadStatus(),
    },
    {
      id: 'cpf',
      label: 'Sem CPF',
      value: (status?.missing_cpf ?? 0).toLocaleString('pt-BR'),
      hint: 'Indicador do espelho — preenchimento roda à noite (att campos)',
      icon: CreditCard,
      accent: 'border-amber-200 bg-amber-50',
    },
    {
      id: 'rgm',
      label: 'Sem RGM',
      value: (status?.missing_rgm ?? 0).toLocaleString('pt-BR'),
      hint: 'Indicador do espelho — não é botão de sync',
      icon: CreditCard,
      accent: 'border-orange-200 bg-orange-50',
    },
    {
      id: 'incomplete',
      label: 'Campos incompletos',
      value: (status?.incomplete_fields ?? 0).toLocaleString('pt-BR'),
      hint: 'Falta CPF, RGM, telefone, e-mail ou nome no cache',
      icon: FileWarning,
      accent: 'border-rose-200 bg-rose-50',
    },
    {
      id: 'sync',
      label: 'Último Full Sync',
      value: last
        ? last.status === 'ok'
          ? fmtDt(last.finished_at || last.started_at)
          : last.status
        : 'Nunca',
      hint: lastDurationMs
        ? `${last?.mode || 'full'} · ${fmtDurationMs(lastDurationMs)}`
        : 'Use o botão Full Sync acima',
      icon: Database,
      accent: 'border-indigo-200 bg-indigo-50',
    },
    {
      id: 'alerts',
      label: 'Alertas',
      value: (status?.open_data_loss_events ?? 0).toLocaleString('pt-BR'),
      hint: 'Regressões no cache — clique para listar',
      icon: AlertTriangle,
      accent:
        (status?.open_data_loss_events ?? 0) > 0
          ? 'border-amber-300 bg-amber-50 hover:border-amber-400'
          : 'border-emerald-200 bg-emerald-50 hover:border-emerald-300',
      onClick: () => void openAlertsPreview(),
    },
  ];

  return (
    <div className="space-y-6">
      <div className="bg-white rounded-2xl border border-gray-100 shadow-sm p-4 sm:p-6">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h2 className="text-base font-semibold text-gray-900">Sync Novo CRM</h2>
            <p className="text-sm text-gray-500 mt-1 max-w-3xl">
              Espelho ≠ att campos ≠ etapas. Dedupe cobre órfãos/duplicados (sem criar leads em massa).
            </p>
            <div className="mt-3 grid grid-cols-1 sm:grid-cols-2 gap-3 max-w-3xl text-xs text-gray-600">
              <div className="rounded-lg border border-gray-100 bg-gray-50 px-3 py-2">
                <p className="font-semibold text-gray-800">De noite (automático)</p>
                <ul className="mt-1 space-y-0.5 list-disc list-inside">
                  <li>
                    <strong>Espelho</strong> — Full Sync copia CRM → Postgres local
                  </li>
                  <li>
                    <strong>Att campos</strong> — matriculados D−1 preenche curso/polo/etc. em
                    quem já está no funil (sem botão aqui)
                  </li>
                </ul>
              </div>
              <div className="rounded-lg border border-indigo-100 bg-indigo-50/50 px-3 py-2">
                <p className="font-semibold text-indigo-900">De dia (manual)</p>
                <ul className="mt-1 space-y-0.5 list-disc list-inside">
                  <li>
                    <strong>Full Sync</strong> — atualiza o espelho agora
                  </li>
                  <li>
                    <strong>Att de etapas</strong> — flags + move etapa
                  </li>
                  <li>
                    <strong>Dedupe</strong> — órfãos / incompletos / duplicados
                  </li>
                </ul>
              </div>
            </div>
          </div>
          <button
            type="button"
            onClick={() => void loadStatus()}
            disabled={loading}
            className="inline-flex items-center gap-1.5 px-3 py-2 text-xs font-medium text-gray-700 bg-white border border-gray-200 rounded-lg hover:bg-gray-50 disabled:opacity-50 shrink-0"
          >
            <RefreshCw className={`w-3.5 h-3.5 ${loading ? 'animate-spin' : ''}`} />
            Atualizar status
          </button>
        </div>

        <p className="mt-5 text-xs font-semibold text-gray-700 uppercase tracking-wide">
          Ações manuais
        </p>
        <div className="mt-2 grid grid-cols-1 sm:grid-cols-3 gap-3">
          <div className="rounded-xl border border-indigo-100 bg-indigo-50/40 p-4 flex flex-col gap-2">
            <p className="text-xs font-semibold text-indigo-900">1. Full Sync</p>
            <p className="text-[11px] text-indigo-800/80 flex-1">
              Reespelha o CRM no cache local. Use quando o painel estiver desatualizado.
            </p>
            <div className="flex flex-wrap gap-2">
              <button
                type="button"
                onClick={() => void runFullSync()}
                disabled={Boolean(status?.running) || syncBusy}
                className="inline-flex items-center justify-center gap-1.5 px-3 py-2 text-xs font-medium text-white bg-indigo-600 hover:bg-indigo-700 rounded-lg disabled:opacity-50 disabled:cursor-not-allowed"
              >
                {status?.running || syncBusy ? (
                  <RefreshCw className="w-3.5 h-3.5 animate-spin" />
                ) : (
                  <Database className="w-3.5 h-3.5" />
                )}
                {status?.running ? 'Sincronizando…' : 'Full Sync'}
              </button>
              {status?.running && (
                <button
                  type="button"
                  onClick={() => void stopFullSync()}
                  disabled={syncStopping}
                  className="inline-flex items-center justify-center gap-1.5 px-3 py-2 text-xs font-medium text-rose-700 bg-white border border-rose-300 hover:bg-rose-50 rounded-lg disabled:opacity-50"
                >
                  <Square className="w-3 h-3 fill-current" />
                  {syncStopping ? 'Parando…' : 'Parar'}
                </button>
              )}
            </div>
          </div>

          <div className="rounded-xl border border-emerald-100 bg-emerald-50/40 p-4 flex flex-col gap-2">
            <p className="text-xs font-semibold text-emerald-900">2. Att de etapas</p>
            <p className="text-[11px] text-emerald-800/80 flex-1">
              Flags (Doc, Financeiro, Situação Financeira/inad vencidos, BB, Evasão) + etapa. CAA→Retenção
              só ≤72h; depois SIAA/Perdido. Não toca Ganho/Cancelado nem Retenção manual (sem CAA open).
              Preenche flag vazia só quando a base pede Sim.
            </p>
            {lastFlags?.finished_at ? (
              <div className="text-[10px] text-emerald-900/80 space-y-0.5 rounded-md border border-emerald-200/80 bg-white/60 px-2 py-1.5">
                <p className="font-semibold text-emerald-900">
                  Última Att (resultado real)
                  {lastFlags.cancelled
                    ? ' · cancelada'
                    : lastFlags.aborted || lastFlags.ok === false
                      ? ' · incompleta'
                      : ''}
                </p>
                <p>{fmtDt(lastFlags.finished_at)}</p>
                <p className="tabular-nums">
                  {Number(lastFlags.scanned || 0).toLocaleString('pt-BR')} deals ·{' '}
                  {Number(lastFlags.matched || 0).toLocaleString('pt-BR')} match ·{' '}
                  {Number(lastFlags.flags_updated || 0).toLocaleString('pt-BR')} flags ·{' '}
                  {Number(lastFlags.stages_moved || 0).toLocaleString('pt-BR')} etapas
                  {lastFlags.stages_skipped_untouchable
                    ? ` · ${Number(lastFlags.stages_skipped_untouchable).toLocaleString('pt-BR')} intocáveis`
                    : ''}
                  {lastFlags.errors
                    ? ` · ${Number(lastFlags.errors).toLocaleString('pt-BR')} erros`
                    : ''}
                </p>
              </div>
            ) : (
              <p className="text-[10px] text-emerald-900/50">Sem Att registrada neste ambiente.</p>
            )}
            <div className="flex flex-wrap gap-2">
              <button
                type="button"
                onClick={() => void runFlagsStageSync()}
                disabled={flagsBusy || flagsRunning}
                className="inline-flex items-center justify-center gap-1.5 px-3 py-2 text-xs font-medium text-white bg-emerald-700 hover:bg-emerald-800 rounded-lg disabled:opacity-50 disabled:cursor-not-allowed"
              >
                {flagsBusy || flagsRunning ? (
                  <RefreshCw className="w-3.5 h-3.5 animate-spin" />
                ) : (
                  <CheckCircle2 className="w-3.5 h-3.5" />
                )}
                {flagsRunning ? 'Att rodando…' : 'Att de etapas'}
              </button>
              {flagsRunning && (
                <button
                  type="button"
                  onClick={() => void stopFlagsStage()}
                  disabled={flagsStopping || Boolean(fj?.cancel_requested)}
                  className="inline-flex items-center justify-center gap-1.5 px-3 py-2 text-xs font-medium text-rose-700 bg-white border border-rose-300 hover:bg-rose-50 rounded-lg disabled:opacity-50"
                >
                  <Square className="w-3 h-3 fill-current" />
                  {flagsStopping || fj?.cancel_requested ? 'Parando…' : 'Parar'}
                </button>
              )}
            </div>
          </div>

          <div className="rounded-xl border border-violet-100 bg-violet-50/40 p-4 flex flex-col gap-2">
            <p className="text-xs font-semibold text-violet-900">
              3. Dedupe órfãos/incompletos/duplicados
            </p>
            <p className="text-[11px] text-violet-800/80 flex-1">
              Confere no CRM ao vivo cada pessoa que o espelho diz estar sem negócio (o espelho gera falsos órfãos) e sincroniza quem já tem. Depois conta o que sobra: negócio novo para quem realmente não tem, preenchimento de CPF/RGM e, quando a mesma pessoa tem dois cartões, mantém um e manda o outro para Perdido.
            </p>
            <button
              type="button"
              onClick={() => void runDedupePreview()}
              disabled={dedupeBusy || Boolean(dedupeJobId)}
              className="inline-flex items-center justify-center gap-1.5 px-3 py-2 text-xs font-medium text-white bg-violet-700 hover:bg-violet-800 rounded-lg disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {dedupeBusy ? <RefreshCw className="w-3.5 h-3.5 animate-spin" /> : <UserRound className="w-3.5 h-3.5" />}
              {dedupeBusy
                ? dedupeMode === 'apply'
                  ? 'Aplicando no CRM…'
                  : 'Conferindo no CRM…'
                : 'Prévia dedupe (confere ao vivo)'}
            </button>
            {dedupeMsg && <p className="text-[11px] text-violet-700">{dedupeMsg}</p>}
            {dedupePreview && (
              <div className="mt-1 text-[11px] text-violet-900 space-y-0.5">
                <p>
                  Sem negócio no espelho: <strong>{dedupePreview.orphans_total.toLocaleString('pt-BR')}</strong> ·
                  já tinham negócio no CRM: <strong>{(dedupePreview.skipped_already_has_deal_live ?? 0).toLocaleString('pt-BR')}</strong>
                  {dedupePreview.warmed_cache ? ` (${dedupePreview.warmed_cache.toLocaleString('pt-BR')} corrigidos no espelho)` : ''}
                </p>
                <p>
                  Negócios a criar de verdade:{' '}
                  <strong>{(dedupePreview.deals_would_create_on_orphan + dedupePreview.deals_would_create_on_sibling).toLocaleString('pt-BR')}</strong>{' '}
                  · sem match no SIAA: {dedupePreview.orphan_no_match.toLocaleString('pt-BR')} · já cobertos por outro cadastro: {dedupePreview.dup_skip_no_deal.toLocaleString('pt-BR')}
                </p>
                <p>
                  Com negócio mas sem CPF/RGM:{' '}
                  <strong>{dedupePreview.incomplete_total.toLocaleString('pt-BR')}</strong> ·
                  duplicados para Perdido:{' '}
                  <strong>{dedupePreview.dup_to_perdido.toLocaleString('pt-BR')}</strong> (
                  {(dedupePreview.deals_would_move_perdido ?? dedupePreview.deals_moved_perdido ?? 0).toLocaleString('pt-BR')}{' '}
                  negócios) · só preencher campos:{' '}
                  <strong>{dedupePreview.incomplete_enriched.toLocaleString('pt-BR')}</strong>
                </p>
                <p>
                  Mesma pessoa com 2+ cartões:{' '}
                  <strong>{(dedupePreview.dup_deal_groups ?? 0).toLocaleString('pt-BR')}</strong> ·
                  cartões a mandar para Perdido:{' '}
                  <strong>
                    {(
                      dedupePreview.dup_deals_would_move_perdido ??
                      dedupePreview.dup_deals_moved_perdido ??
                      0
                    ).toLocaleString('pt-BR')}
                  </strong>
                  {dedupePreview.dup_cross_contact
                    ? ` · ${dedupePreview.dup_cross_contact.toLocaleString('pt-BR')} em cadastros diferentes`
                    : ''}
                  {dedupePreview.dup_resolved_live
                    ? ` · ${dedupePreview.dup_resolved_live.toLocaleString('pt-BR')} já resolvidos no CRM`
                    : ''}
                </p>
                <p>Casados por e-mail: {dedupePreview.matched_email.toLocaleString('pt-BR')} · por telefone: {dedupePreview.matched_phone.toLocaleString('pt-BR')}</p>
                <p className="text-violet-700/80">
                  Barrados pela conferência: {(dedupePreview.incomplete_live_already_ok ?? 0).toLocaleString('pt-BR')} já
                  preenchidos no CRM · {(dedupePreview.incomplete_ambiguous ?? 0).toLocaleString('pt-BR')} e-mail/telefone de
                  mais de um aluno · {(dedupePreview.incomplete_name_mismatch ?? 0).toLocaleString('pt-BR')} nome divergente
                  {dedupePreview.incomplete_live_conflict
                    ? ` · ${dedupePreview.incomplete_live_conflict.toLocaleString('pt-BR')} valor diferente no CRM (não sobrescrito)`
                    : ''}
                </p>
                {dedupeApplied ? (
                  <p className="pt-1 font-semibold text-violet-900">
                    Aplicado: {dedupePreview.created_deals.toLocaleString('pt-BR')} negócios criados ·{' '}
                    {(
                      (dedupePreview.deals_moved_perdido ?? 0) +
                      (dedupePreview.dup_deals_moved_perdido ?? 0)
                    ).toLocaleString('pt-BR')}{' '}
                    movidos para Perdido ·{' '}
                    {dedupePreview.incomplete_enriched.toLocaleString('pt-BR')} campos preenchidos
                    {dedupePreview.errors
                      ? ` · ${dedupePreview.errors.toLocaleString('pt-BR')} falhas`
                      : ''}
                  </p>
                ) : (
                  <div className="flex gap-2 pt-1.5">
                    <button
                      type="button"
                      onClick={() => void confirmDedupeApply()}
                      className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-white bg-violet-700 hover:bg-violet-800 rounded-lg"
                    >
                      <UserRound className="w-3.5 h-3.5" />
                      Aplicar
                    </button>
                    <button
                      type="button"
                      onClick={dismissDedupePreview}
                      className="px-3 py-1.5 text-xs font-medium text-violet-800 border border-violet-300 hover:bg-violet-50 rounded-lg"
                    >
                      Descartar
                    </button>
                  </div>
                )}
              </div>
            )}
          </div>
        </div>

        {error && <p className="mt-3 text-sm text-rose-600">{error}</p>}
        {syncMsg && !status?.running && (
          <p className="mt-3 text-sm text-indigo-700 flex items-center gap-2">
            <CheckCircle2 className="w-4 h-4 shrink-0" />
            {syncMsg}
          </p>
        )}
        {flagsMsg && !flagsRunning && (
          <p className="mt-3 text-sm text-emerald-800 flex items-center gap-2">
            <CheckCircle2 className="w-4 h-4 shrink-0" />
            {flagsMsg}
          </p>
        )}

        {status?.running && (
          <div className="mt-4 max-w-xl rounded-xl border border-indigo-200 bg-indigo-50/50 p-3">
            <div className="flex items-center justify-between gap-2 mb-1">
              <p className="text-xs font-medium text-indigo-900">
                Full Sync ({running?.mode || 'full'}) em andamento
              </p>
              <button
                type="button"
                onClick={() => void stopFullSync()}
                disabled={syncStopping}
                className="inline-flex items-center gap-1 px-2 py-1 text-[11px] font-medium text-rose-700 border border-rose-300 rounded-md hover:bg-rose-50 disabled:opacity-50"
              >
                <Square className="w-2.5 h-2.5 fill-current" />
                Parar
              </button>
            </div>
            <div className="h-2.5 w-full overflow-hidden rounded-full bg-indigo-100">
              <div
                className={`h-full rounded-full bg-indigo-600 transition-[width] duration-500 ${
                  pct == null ? 'animate-pulse w-1/3' : ''
                }`}
                style={pct == null ? undefined : { width: `${pct}%` }}
              />
            </div>
            <p className="mt-1.5 text-[11px] text-gray-600 tabular-nums">
              {pct != null
                ? `${pct}% · ${seen.toLocaleString('pt-BR')} de ${(total ?? 0).toLocaleString('pt-BR')} contatos`
                : `${seen.toLocaleString('pt-BR')} processados…`}
              {running?.cache_upserted != null
                ? ` · ${Number(running.cache_upserted).toLocaleString('pt-BR')} upserts`
                : ''}
            </p>
          </div>
        )}

        {flagsRunning && (
          <div className="mt-4 max-w-xl rounded-xl border border-emerald-200 bg-emerald-50/60 p-3">
            <div className="flex items-center justify-between gap-2 mb-1">
              <p className="text-xs font-semibold text-emerald-900">
                Att de etapas · {phaseLabel(fj?.phase)}
                {fj?.cancel_requested ? ' · cancelando…' : ''}
              </p>
              <button
                type="button"
                onClick={() => void stopFlagsStage()}
                disabled={flagsStopping || Boolean(fj?.cancel_requested)}
                className="inline-flex items-center gap-1 px-2 py-1 text-[11px] font-medium text-rose-700 border border-rose-300 rounded-md hover:bg-rose-50 disabled:opacity-50"
              >
                <Square className="w-2.5 h-2.5 fill-current" />
                Parar
              </button>
            </div>
            <div className="h-2.5 w-full overflow-hidden rounded-full bg-emerald-100">
              <div
                className={`h-full rounded-full bg-emerald-600 transition-[width] duration-500 ${
                  flagsPct == null ? 'animate-pulse w-1/3' : ''
                }`}
                style={flagsPct == null ? undefined : { width: `${flagsPct}%` }}
              />
            </div>
            <div className="mt-1.5 space-y-0.5 text-[11px] text-emerald-950/80 tabular-nums">
              <p>
                {flagsPct != null
                  ? `${flagsPct}% · ${Number(fj?.processed || 0).toLocaleString('pt-BR')} / ${Number(fj?.total || 0).toLocaleString('pt-BR')}`
                  : `${Number(fj?.processed || 0).toLocaleString('pt-BR')} processados…`}
                {fj?.matched != null
                  ? ` · match ${Number(fj.matched).toLocaleString('pt-BR')}`
                  : ''}
              </p>
              <p>
                Flags gravadas: {Number(fj?.flags_updated || 0).toLocaleString('pt-BR')} · Etapas:{' '}
                {Number(fj?.stages_moved || 0).toLocaleString('pt-BR')}
                {flagsElapsed ? ` · decorrido ${flagsElapsed}` : ''}
                {flagsEta ? ` · ETA ~${flagsEta}` : ''}
              </p>
              {fj?.status_message && (
                <p className="text-emerald-800/70 truncate">{fj.status_message}</p>
              )}
            </div>
          </div>
        )}

        <p className="mt-6 text-xs font-semibold text-gray-700 uppercase tracking-wide">
          Status do espelho (só indicadores — não enriquecem)
        </p>
        <div className="mt-2 grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
          {tiles.map((t) => {
            const Icon = t.icon;
            const clickable = Boolean(t.onClick);
            const Comp = clickable ? 'button' : 'div';
            return (
              <Comp
                key={t.id}
                type={clickable ? 'button' : undefined}
                onClick={t.onClick}
                className={`text-left rounded-xl border p-4 ${t.accent} ${
                  clickable ? 'transition-all cursor-pointer' : ''
                }`}
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
              </Comp>
            );
          })}
        </div>
      </div>

      {alertsPreview && (
        <div className="fixed inset-0 z-50 flex items-start justify-center p-4 sm:p-8 bg-black/40 overflow-y-auto">
          <div className="w-full max-w-lg bg-white rounded-2xl shadow-xl border border-gray-100 my-8">
            <div className="flex items-center justify-between px-5 py-4 border-b border-gray-100">
              <h3 className="text-sm font-semibold text-gray-900">Alertas de perda de dados</h3>
              <button
                type="button"
                onClick={() => setAlertsPreview(null)}
                className="p-1 rounded-lg text-gray-400 hover:bg-gray-100"
              >
                <X className="w-4 h-4" />
              </button>
            </div>
            <div className="px-5 py-4 text-sm text-gray-700 space-y-3 max-h-[60vh] overflow-y-auto">
              {alertsPreview.loading && <p className="text-gray-500">Carregando…</p>}
              {alertsPreview.error && <p className="text-rose-600">{alertsPreview.error}</p>}
              {alertsPreview.alerts && (
                <div className="space-y-2">
                  {alertsPreview.alerts.length === 0 ? (
                    <p className="text-emerald-700">Nenhum alerta aberto.</p>
                  ) : (
                    alertsPreview.alerts.map((ev) => (
                      <div
                        key={String(ev.id)}
                        className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs"
                      >
                        <p className="font-medium">
                          #{ev.id} · {ev.contact_id || '—'}
                        </p>
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
            </div>
            <div className="px-5 py-4 border-t border-gray-100 flex justify-end">
              <button
                type="button"
                onClick={() => setAlertsPreview(null)}
                className="px-3 py-2 text-xs font-medium text-gray-700 border border-gray-200 rounded-lg hover:bg-gray-50"
              >
                Fechar
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
