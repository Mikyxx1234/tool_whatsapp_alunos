import { useCallback, useEffect, useRef, useState } from 'react';
import {
  AlertTriangle,
  CheckCircle2,
  CreditCard,
  Database,
  FileWarning,
  RefreshCw,
  UserPlus,
  UserRound,
  X,
} from 'lucide-react';
import {
  maintenanceApi,
  type NovoCrmCacheStatusResponse,
  type NovoCrmProvisionPreviewResponse,
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
  if (ms < 60_000) return `${Math.round(ms / 1000)} s`;
  return `${Math.floor(ms / 60_000)} min`;
}

type AlertsPreview = {
  loading: boolean;
  error: string | null;
  alerts: NovoCrmRegressionEvent[] | null;
};

export function NovoCrmSyncPanel() {
  const [status, setStatus] = useState<NovoCrmCacheStatusResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [alertsPreview, setAlertsPreview] = useState<AlertsPreview | null>(null);

  const [syncBusy, setSyncBusy] = useState(false);
  const [syncMsg, setSyncMsg] = useState<string | null>(null);

  const [flagsJobId, setFlagsJobId] = useState<string | null>(null);
  const [flagsMsg, setFlagsMsg] = useState<string | null>(null);
  const [flagsBusy, setFlagsBusy] = useState(false);

  const [provisionJobId, setProvisionJobId] = useState<string | null>(null);
  const [provisionMsg, setProvisionMsg] = useState<string | null>(null);
  const [provisionBusy, setProvisionBusy] = useState(false);
  const [provisionPreview, setProvisionPreview] = useState<NovoCrmProvisionPreviewResponse | null>(
    null
  );

  const [dedupeBusy, setDedupeBusy] = useState(false);
  const [dedupeMsg, setDedupeMsg] = useState<string | null>(null);
  const [dedupePreview, setDedupePreview] = useState<OrphanDedupePreviewResponse | null>(null);

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
    if (status?.running || flagsJobId || provisionJobId) {
      stopPoll();
      pollRef.current = window.setInterval(() => {
        void loadStatus();
        if (flagsJobId) {
          void maintenanceApi
            .getNovoCrmFlagsStageStatus(flagsJobId)
            .then((r) => {
              if (!r.job) return;
              setFlagsMsg(r.job.status_message || r.job.phase || null);
              if (r.job.status !== 'running') {
                setFlagsJobId(null);
                setFlagsBusy(false);
                if (r.job.status === 'completed') {
                  const res = r.job.result;
                  setFlagsMsg(
                    `Att de etapas: ${res?.flags_updated ?? 0} flags · ${res?.stages_moved ?? 0} movidos` +
                      (res?.stages_skipped_untouchable
                        ? ` · ${res.stages_skipped_untouchable} intocáveis`
                        : '') +
                      (res?.errors ? ` · ${res.errors} erros` : '')
                  );
                } else if (r.job.status === 'failed') {
                  setFlagsMsg(r.job.error || 'Att de etapas falhou');
                }
                void loadStatus();
              }
            })
            .catch(() => {});
        }
        if (provisionJobId) {
          void maintenanceApi
            .getNovoCrmProvisionStatus(provisionJobId)
            .then(async (r) => {
              if (!r.job) return;
              setProvisionMsg(r.job.status_message || r.job.phase || null);
              if (r.job.status !== 'running') {
                stopPoll();
                setProvisionJobId(null);
                if (r.job.status === 'completed') {
                  const res = r.job.result;
                  if (r.job.dry_run && res) {
                    setProvisionBusy(false);
                    if (!res.created_contacts) {
                      setProvisionMsg(
                        `Verificação concluída: ninguém para criar` +
                          (res.updated_existing
                            ? ` · ${res.updated_existing} já existiam no CRM e foram sincronizados`
                            : '')
                      );
                    } else {
                      setProvisionPreview(res);
                      setProvisionMsg('Verificação ao vivo concluída — confirme abaixo.');
                    }
                  } else {
                    setProvisionBusy(false);
                    setProvisionMsg(
                      `Leads novos: ${res?.created_contacts ?? 0} contatos · ${res?.created_deals ?? 0} deals` +
                        (res?.updated_existing
                          ? ` · ${res.updated_existing} já existiam (só sincronizados)`
                          : '') +
                        (res?.errors ? ` · ${res.errors} erros` : '')
                    );
                  }
                } else if (r.job.status === 'failed') {
                  setProvisionBusy(false);
                  setProvisionMsg(r.job.error || 'Criação de leads falhou');
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
  }, [status?.running, flagsJobId, provisionJobId, loadStatus, stopPoll]);

  const last = status?.last_sync || null;
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

  const runFlagsStageSync = async () => {
    if (flagsBusy || flagsJobId) return;
    setFlagsBusy(true);
    setFlagsMsg('Calculando prévia de etapas/flags…');
    try {
      const preview = await maintenanceApi.previewNovoCrmFlagsStage({
        mode: 'flags_stage',
        max: 2000,
      });
      const ok = window.confirm(
        `Att de etapas (prévia em até 2.000 deals)\n\n` +
          `Match: ${preview.matched.toLocaleString('pt-BR')}\n` +
          `Flags a atualizar: ${preview.flags_updated.toLocaleString('pt-BR')}\n` +
          `Etapas a mover: ${preview.stages_moved.toLocaleString('pt-BR')}\n` +
          `Intocáveis (Ganho/Cancelado + Retenção sem CAA open): ${preview.stages_skipped_untouchable.toLocaleString('pt-BR')}\n\n` +
          `CAA → Retenção só nas primeiras 72h (data chegada). Depois segue status SIAA.\n` +
          `Confirmar aplicação?\n` +
          `(Dica: rode Full Sync antes se criou gente recentemente.)`
      );
      if (!ok) {
        setFlagsMsg('Cancelado.');
        setFlagsBusy(false);
        return;
      }
      const started = await maintenanceApi.startNovoCrmFlagsStage({ mode: 'flags_stage' });
      setFlagsJobId(started.jobId);
      setFlagsMsg('Att de etapas em andamento…');
    } catch (e) {
      setFlagsMsg(e instanceof Error ? e.message : 'Falha no Att de etapas');
      setFlagsBusy(false);
    }
  };

  const runNewLeadsProvision = async () => {
    if (provisionBusy || provisionJobId) return;
    setProvisionBusy(true);
    setProvisionPreview(null);
    setProvisionMsg('Verificando candidatos ao vivo no CRM…');
    try {
      const started = await maintenanceApi.startNovoCrmProvisionPreview({
        mode: 'new',
        max: 200,
      });
      setProvisionJobId(started.jobId);
      setProvisionMsg('Verificação ao vivo em andamento…');
    } catch (e) {
      setProvisionMsg(e instanceof Error ? e.message : 'Falha na criação de leads');
      setProvisionBusy(false);
    }
  };

  const confirmNewLeadsApply = async () => {
    const preview = provisionPreview;
    if (!preview || provisionJobId) return;
    setProvisionPreview(null);
    setProvisionBusy(true);
    setProvisionMsg('Criando somente os leads ausentes…');
    try {
      const started = await maintenanceApi.startNovoCrmProvision({
        mode: 'new',
        max: preview.max_creates,
      });
      setProvisionJobId(started.jobId);
    } catch (e) {
      setProvisionBusy(false);
      setProvisionMsg(e instanceof Error ? e.message : 'Falha ao iniciar criação de leads');
    }
  };

  const dismissNewLeadsPreview = () => {
    const preview = provisionPreview;
    setProvisionPreview(null);
    setProvisionMsg(
      preview
        ? `Criação descartada · ${preview.created_contacts} ausentes · ` +
            `${preview.updated_existing ?? 0} já existiam no CRM (sincronizados)`
        : null
    );
  };

  const runDedupePreview = async () => {
    if (dedupeBusy) return;
    setDedupeBusy(true);
    setDedupeMsg('Calculando prévia dedupe…');
    setDedupePreview(null);
    try {
      const preview = await maintenanceApi.previewOrphanDedupe({ scope: 'both' });
      setDedupePreview(preview);
      setDedupeMsg(null);
    } catch (e) {
      setDedupeMsg(e instanceof Error ? e.message : 'Falha na prévia dedupe');
    } finally {
      setDedupeBusy(false);
    }
  };

  const running = status?.running_sync || null;
  const total = running?.contacts_total ?? null;
  const seen = running?.contacts_seen ?? 0;
  const pct =
    total && total > 0 ? Math.min(100, Math.round((seen / total) * 100)) : null;

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
              Espelho ≠ att campos ≠ etapas ≠ leads novos. Não misture.
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
                <p className="font-semibold text-indigo-900">De dia (manual — 3 botões)</p>
                <ul className="mt-1 space-y-0.5 list-disc list-inside">
                  <li>
                    <strong>Full Sync</strong> — atualiza o espelho agora
                  </li>
                  <li>
                    <strong>Att de etapas</strong> — flags + move etapa
                  </li>
                  <li>
                    <strong>Leads novos</strong> — cria ~10–150 do dia
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
          </div>

          <div className="rounded-xl border border-emerald-100 bg-emerald-50/40 p-4 flex flex-col gap-2">
            <p className="text-xs font-semibold text-emerald-900">2. Att de etapas</p>
            <p className="text-[11px] text-emerald-800/80 flex-1">
              Flags + etapa. CAA→Retenção só ≤72h; depois SIAA/Perdido. Não toca Ganho/Cancelado nem
              Retenção manual (sem CAA open).
            </p>
            <button
              type="button"
              onClick={() => void runFlagsStageSync()}
              disabled={flagsBusy || Boolean(flagsJobId)}
              className="inline-flex items-center justify-center gap-1.5 px-3 py-2 text-xs font-medium text-white bg-emerald-700 hover:bg-emerald-800 rounded-lg disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {flagsBusy || flagsJobId ? (
                <RefreshCw className="w-3.5 h-3.5 animate-spin" />
              ) : (
                <CheckCircle2 className="w-3.5 h-3.5" />
              )}
              {flagsJobId ? 'Att de etapas…' : 'Att de etapas'}
            </button>
          </div>

          <div className="rounded-xl border border-sky-100 bg-sky-50/40 p-4 flex flex-col gap-2">
            <p className="text-xs font-semibold text-sky-900">3. Criação de leads novos</p>
            <p className="text-[11px] text-sky-800/80 flex-1">
              Verifica os candidatos ao vivo no CRM, sincroniza quem já existe e cria somente os
              ausentes. Cap 200.
            </p>
            <button
              type="button"
              onClick={() => void runNewLeadsProvision()}
              disabled={provisionBusy || Boolean(provisionJobId)}
              className="inline-flex items-center justify-center gap-1.5 px-3 py-2 text-xs font-medium text-white bg-sky-700 hover:bg-sky-800 rounded-lg disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {provisionBusy || provisionJobId ? (
                <RefreshCw className="w-3.5 h-3.5 animate-spin" />
              ) : (
                <UserPlus className="w-3.5 h-3.5" />
              )}
              {provisionJobId ? 'Verificando / criando…' : 'Criação de leads novos'}
            </button>
            {provisionPreview && (
              <div className="mt-1 rounded-lg border border-sky-300 bg-white p-3 text-[11px] text-sky-900 space-y-1">
                <p className="font-semibold text-xs">Verificação ao vivo concluída</p>
                <p>
                  A criar:{' '}
                  <strong>{provisionPreview.created_contacts.toLocaleString('pt-BR')}</strong>{' '}
                  pessoas · {provisionPreview.created_deals.toLocaleString('pt-BR')} deals
                  {provisionPreview.created_contacts >= (provisionPreview.max_creates || 200)
                    ? ` (teto ${provisionPreview.max_creates || 200}/run)`
                    : ''}
                </p>
                <p>
                  Já existiam no CRM:{' '}
                  <strong>{(provisionPreview.updated_existing ?? 0).toLocaleString('pt-BR')}</strong>{' '}
                  (sincronizados no espelho; cards não alterados)
                </p>
                <p>
                  Já estavam no espelho:{' '}
                  {provisionPreview.skipped_cache.toLocaleString('pt-BR')} por CPF ·{' '}
                  {(provisionPreview.skipped_cache_rgm ?? 0).toLocaleString('pt-BR')} por RGM
                </p>
                {provisionPreview.errors ? (
                  <p className="text-rose-700">
                    Falhas na verificação: {provisionPreview.errors.toLocaleString('pt-BR')}
                  </p>
                ) : null}
                <p className="text-sky-700/80">
                  O apply repete a busca ao vivo imediatamente antes de cada criação.
                </p>
                <div className="flex gap-2 pt-1">
                  <button
                    type="button"
                    onClick={() => void confirmNewLeadsApply()}
                    className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-white bg-sky-700 hover:bg-sky-800 rounded-lg"
                  >
                    <UserPlus className="w-3.5 h-3.5" />
                    Criar {provisionPreview.created_contacts.toLocaleString('pt-BR')} leads
                  </button>
                  <button
                    type="button"
                    onClick={dismissNewLeadsPreview}
                    className="px-3 py-1.5 text-xs font-medium text-sky-800 border border-sky-300 hover:bg-sky-50 rounded-lg"
                  >
                    Descartar
                  </button>
                </div>
              </div>
            )}
          </div>

          <div className="rounded-xl border border-violet-100 bg-violet-50/40 p-4 flex flex-col gap-2">
            <p className="text-xs font-semibold text-violet-900">4. Dedupe órfãos/incompletos</p>
            <p className="text-[11px] text-violet-800/80 flex-1">
              Prévia: conta contacts sem deal (órfãos) e com deal sem CPF/RGM (incompletos) matchados por e-mail ou telefone. Sibling melhor → deal do ruim vai para Perdido. Sem sibling → enrich leve (CPF/RGM).
            </p>
            <button
              type="button"
              onClick={() => void runDedupePreview()}
              disabled={dedupeBusy}
              className="inline-flex items-center justify-center gap-1.5 px-3 py-2 text-xs font-medium text-white bg-violet-700 hover:bg-violet-800 rounded-lg disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {dedupeBusy ? <RefreshCw className="w-3.5 h-3.5 animate-spin" /> : <UserRound className="w-3.5 h-3.5" />}
              {dedupeBusy ? 'Calculando…' : 'Prévia dedupe (scope=both)'}
            </button>
            {dedupeMsg && <p className="text-[11px] text-violet-700">{dedupeMsg}</p>}
            {dedupePreview && (
              <div className="mt-1 text-[11px] text-violet-900 space-y-0.5">
                <p>Órfãos: <strong>{dedupePreview.orphans_total.toLocaleString('pt-BR')}</strong> · Aluno: <strong>{dedupePreview.orphan_aluno.toLocaleString('pt-BR')}</strong> · Sem match: {dedupePreview.orphan_no_match.toLocaleString('pt-BR')}</p>
                <p>Dup skip (sem deal): {dedupePreview.dup_skip_no_deal.toLocaleString('pt-BR')} · Deals criaria: <strong>{(dedupePreview.deals_would_create_on_orphan + dedupePreview.deals_would_create_on_sibling).toLocaleString('pt-BR')}</strong></p>
                <p>Incompletos: <strong>{dedupePreview.incomplete_total.toLocaleString('pt-BR')}</strong> · Dup→Perdido: <strong>{dedupePreview.dup_to_perdido.toLocaleString('pt-BR')}</strong> ({(dedupePreview.deals_would_move_perdido ?? 0).toLocaleString('pt-BR')} deals) · Enrich: {dedupePreview.incomplete_enriched.toLocaleString('pt-BR')}</p>
                <p>Match e-mail: {dedupePreview.matched_email.toLocaleString('pt-BR')} · telefone: {dedupePreview.matched_phone.toLocaleString('pt-BR')}</p>
              </div>
            )}
          </div>
        </div>

        {error && <p className="mt-3 text-sm text-rose-600">{error}</p>}
        {syncMsg && (
          <p className="mt-3 text-sm text-indigo-700 flex items-center gap-2">
            <CheckCircle2 className="w-4 h-4 shrink-0" />
            {syncMsg}
          </p>
        )}
        {flagsMsg && (
          <p className="mt-3 text-sm text-emerald-800 flex items-center gap-2">
            <CheckCircle2 className="w-4 h-4 shrink-0" />
            {flagsMsg}
          </p>
        )}
        {provisionMsg && (
          <p className="mt-3 text-sm text-sky-800 flex items-center gap-2">
            <CheckCircle2 className="w-4 h-4 shrink-0" />
            {provisionMsg}
          </p>
        )}

        {status?.running && (
          <div className="mt-4 max-w-lg">
            <p className="text-xs font-medium text-amber-700 mb-1">
              Full Sync ({running?.mode || 'full'}) em andamento…
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
