import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Download, Zap, Loader2, CheckCircle2, AlertTriangle } from 'lucide-react';
import {
  activationApi,
  type ActivationCategory,
  type DatacrazyBatchNotFoundItem,
} from '../services/activationApi';
import { readConsultorIdentity } from '../services/meuPainelApi';
import { LoadingOverlay } from './LoadingOverlay';

interface Props {
  category: ActivationCategory;
  label: string;
  /** Total da interseção no painel (Relatórios). */
  total: number;
  /** Após disparo ou marcar ativados — atualiza tabela. */
  onFilaChanged?: () => void;
  /** master_keys selecionados na tabela. Se houver, o botão dispara só pra eles. */
  selectedMasterKeys?: string[];
  /** Chamado após disparo bem sucedido (limpa seleção). */
  onClearSelection?: () => void;
}

const CATEGORY_LABEL: Record<ActivationCategory, string> = {
  'docs-pendentes': 'Documentos pendentes',
  financeiro: 'Inadimplentes / mensalidade em aberto',
  'provavel-evasao': 'Provável evasão (faixa de risco)',
  'acessos-blackboard': 'Sem acesso BB (fora do export)',
  'processos-caa': 'CAA cancelamento',
  'aguardando-inicio': 'Aguardando início da turma',
  rematricula: 'Rematrícula (2026/1 → 2026/2)',
};

export function ActivationListActions({
  category,
  label,
  total,
  onFilaChanged,
  selectedMasterKeys,
  onClearSelection,
}: Props) {
  const selectedCount = selectedMasterKeys?.length ?? 0;
  const hasSelection = selectedCount > 0;
  const consultorNome = useMemo(() => readConsultorIdentity().nome ?? undefined, []);
  const [running, setRunning] = useState(false);
  const [overlayMinimized, setOverlayMinimized] = useState(false);
  const eligible = total;
  const [progress, setProgress] = useState<{
    processed: number;
    total: number;
    percent: number;
    stats?: string;
  } | null>(null);
  const pollingRef = useRef<number | null>(null);
  const consecutiveErrorsRef = useRef(0);

  const stopPolling = useCallback(() => {
    if (pollingRef.current != null) {
      window.clearInterval(pollingRef.current);
      pollingRef.current = null;
    }
  }, []);

  useEffect(() => stopPolling, [stopPolling]);

  useEffect(() => {
    if (!running) setOverlayMinimized(false);
  }, [running]);
  const [marking, setMarking] = useState(false);
  const [batch, setBatch] = useState<{
    sent: number;
    not_found: number;
    failed: number;
    skipped: number;
    processed: number;
    pages?: number;
    scanned?: number;
  } | null>(null);
  const [notFoundItems, setNotFoundItems] = useState<DatacrazyBatchNotFoundItem[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [origemBlocked, setOrigemBlocked] = useState<string | null>(null);

  const runSearchAndActivate = useCallback(async () => {
    const targetCount = hasSelection ? selectedCount : eligible;
    if (!targetCount) return;
    const confirmMsg = hasSelection
      ? selectedCount > 500
        ? `Disparar template para ${selectedCount.toLocaleString('pt-BR')} aluno(s) SELECIONADO(S) em «${CATEGORY_LABEL[category]}»?\n\nO sistema divide automaticamente em blocos de 500 e processa um após o outro (pode levar horas em bases grandes).\n\nEsta ação envia mensagens WhatsApp reais.`
        : `Disparar template para ${selectedCount} aluno(s) SELECIONADO(S) em «${CATEGORY_LABEL[category]}»?\n\nEsta ação envia mensagens WhatsApp reais.`
      : eligible > 500
        ? `Buscar no DataCrazy e enviar mensagem para ${eligible.toLocaleString('pt-BR')} pessoa(s) em «${CATEGORY_LABEL[category]}»?\n\nSerão processados em blocos automáticos de 500 (com pausa entre blocos). Você pode acompanhar o progresso no overlay — não precisa ficar disparando manualmente a cada 10 min.\n\nQuem não for encontrado entra na lista para CSV.`
        : `Buscar no DataCrazy e enviar mensagem de ativação para até ${eligible.toLocaleString('pt-BR')} pessoa(s) em «${CATEGORY_LABEL[category]}»?\n\n` +
          'A mensagem muda na 1ª ativação e na 5ª (templates no .env). Quem não for encontrado entra na lista para CSV.';
    const ok = window.confirm(confirmMsg);
    if (!ok) return;

    setRunning(true);
    setError(null);
    setOrigemBlocked(null);
    setBatch(null);
    setNotFoundItems([]);
    setProgress({ processed: 0, total: 0, percent: 0 });
    consecutiveErrorsRef.current = 0;

    try {
      const { jobId } = await activationApi.runDatacrazyBatchAsync(
        category,
        hasSelection
          ? { masterKeys: selectedMasterKeys, operatorNome: consultorNome }
          : { operatorNome: consultorNome }
      );

      pollingRef.current = window.setInterval(async () => {
        try {
          const job = await activationApi.getJobProgress(jobId);
          consecutiveErrorsRef.current = 0;
          const percent =
            job.total > 0 ? Math.min(100, Math.round((job.processed / job.total) * 100)) : 0;
          const chunkLabel =
            job.chunk_total && job.chunk_total > 1
              ? ` · bloco ${job.chunk_index ?? '?'}/${job.chunk_total}`
              : '';
          setProgress({
            processed: job.processed,
            total: job.total,
            percent,
            stats: `${job.sent} enviados · ${job.not_found} não encontrados · ${job.failed} falhas${chunkLabel}`,
          });

          if (job.status === 'completed' && job.result) {
            stopPolling();
            const result = job.result;
            if (result.origem_ativacao_blocked) {
              setOrigemBlocked(
                result.message ||
                  'Disparo interrompido: o campo origem_ativacao não foi gravado no DataCrazy. As respostas não serão mensuradas até corrigir a integração.'
              );
            }
            setBatch({
              sent: result.sent,
              not_found: result.not_found,
              failed: result.failed,
              skipped: result.skipped,
              processed: result.processed,
              pages: result.datacrazy_pages,
              scanned: result.datacrazy_leads_scanned,
            });
            setNotFoundItems(result.not_found_items ?? []);
            onFilaChanged?.();
            if (hasSelection) onClearSelection?.();
            setRunning(false);
            setProgress(null);
          } else if (job.status === 'failed') {
            stopPolling();
            setError(job.error || 'Erro ao processar disparo');
            setRunning(false);
            setProgress(null);
          }
        } catch {
          consecutiveErrorsRef.current += 1;
          if (consecutiveErrorsRef.current >= 3) {
            stopPolling();
            setError(
              'Conexão perdida durante o disparo. O envio pode ter continuado — verifique os relatórios.'
            );
            setRunning(false);
            setProgress(null);
          }
        }
      }, 2000) as unknown as number;
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Erro ao iniciar disparo');
      setRunning(false);
      setProgress(null);
    }
  }, [category, eligible, hasSelection, selectedCount, selectedMasterKeys, onFilaChanged, onClearSelection, stopPolling]);

  const downloadNotFoundCsv = useCallback(async () => {
    if (!notFoundItems.length) return;
    setError(null);
    try {
      await activationApi.downloadNotFoundCsv(category, notFoundItems);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Erro ao baixar CSV');
    }
  }, [category, notFoundItems]);

  const downloadListCsv = useCallback(async () => {
    if (!eligible) return;
    setError(null);
    try {
      const res = await fetch(activationApi.exportCsvUrl(category, { includeSent: true }));
      if (!res.ok) {
        const t = await res.text();
        throw new Error(t || `Falha ao baixar (${res.status})`);
      }
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `ativacao-${category}.csv`;
      a.click();
      URL.revokeObjectURL(url);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Erro ao baixar lista');
    }
  }, [category, eligible]);

  const markAllWithoutDownload = useCallback(async () => {
    if (!eligible) return;
    const ok = window.confirm(
      `Marcar ${eligible.toLocaleString('pt-BR')} pessoa(s) como já ativadas em «${CATEGORY_LABEL[category]}»?\n\n` +
        'Use só se ativou por outro canal. O histórico de mensagens (1ª, 5ª…) continua no banco.'
    );
    if (!ok) return;
    setMarking(true);
    setError(null);
    try {
      await activationApi.markDispatched(category, { markAllEligible: true });
      onFilaChanged?.();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Erro ao registrar ativação');
    } finally {
      setMarking(false);
    }
  }, [category, eligible, onFilaChanged]);

  const batchEstimate = hasSelection
    ? selectedCount
    : running && progress?.total
      ? progress.total
      : eligible;
  // ~100 leads/min; lotes >500 rodam em blocos automáticos no servidor.
  const chunkSize = 500;
  const estMinutes =
    batchEstimate > chunkSize
      ? Math.ceil(batchEstimate / 80)
      : Math.min(Math.max(Math.ceil(batchEstimate / 100), 2), 15);

  return (
    <div className="mt-3 pt-3 border-t border-gray-200 space-y-2">
      <p className="text-xs font-semibold text-gray-700 dark:text-slate-300 flex items-center gap-1">
        <Zap className="w-3.5 h-3.5" />
        Ativação — {label}
      </p>
      <p className="text-[10px] text-gray-600 dark:text-slate-400 leading-snug">
        <strong className="text-gray-900 dark:text-slate-100 font-semibold">{eligible.toLocaleString('pt-BR')}</strong> na interseção
        (matrícula × base, conforme Relatórios). A tabela abaixo pode levar ~1 min na 1ª abertura.
      </p>
      <p className="text-[10px] text-gray-600 dark:text-slate-400 leading-snug">
        Docs, inadimplentes, Blackboard e CAA são independentes. Na <strong className="text-gray-900 dark:text-slate-100 font-semibold">mesma</strong> campanha, a mensagem muda na 1ª
        ativação e na 5ª (não envia o mesmo template duas vezes).
      </p>
      <p className="text-[10px] text-gray-600 dark:text-slate-400 leading-snug">
        Escolha os templates na seção acima (mesma lista do Disparo manual). «Buscar e ativar» localiza
        no DataCrazy e dispara o template na hora. Acima de 500 pessoas, o sistema divide em blocos
        automáticos (estimativa ~{estMinutes} min para filas grandes).
      </p>
      <div className="flex flex-wrap gap-2">
        <button
          type="button"
          disabled={marking || eligible === 0}
          onClick={() => void downloadListCsv()}
          className="inline-flex items-center gap-1 px-2.5 py-1.5 text-[11px] font-medium text-gray-700 dark:text-slate-200 bg-white dark:bg-slate-800/60 border border-gray-200 dark:border-slate-700 rounded-lg hover:bg-gray-50 dark:hover:bg-slate-800 disabled:opacity-50"
        >
          <Download className="w-3 h-3" />
          Baixar lista (CSV)
        </button>
        <button
          type="button"
          disabled={running || (hasSelection ? selectedCount === 0 : eligible === 0)}
          onClick={() => void runSearchAndActivate()}
          className="inline-flex items-center gap-1 px-2.5 py-1.5 text-[11px] font-medium text-white bg-whatsapp-600 rounded-lg hover:bg-whatsapp-700 disabled:opacity-50"
        >
          {running ? <Loader2 className="w-3 h-3 animate-spin" /> : <Zap className="w-3 h-3" />}
          {hasSelection ? `Ativar selecionados (${selectedCount})` : 'Buscar e ativar'}
        </button>
        {hasSelection && (
          <button
            type="button"
            onClick={() => onClearSelection?.()}
            className="inline-flex items-center gap-1 px-2.5 py-1.5 text-[11px] font-medium text-gray-700 dark:text-slate-200 bg-white dark:bg-slate-800/60 border border-gray-200 dark:border-slate-700 rounded-lg hover:bg-gray-50 dark:hover:bg-slate-800"
          >
            Limpar seleção
          </button>
        )}
        {notFoundItems.length > 0 && (
          <button
            type="button"
            onClick={() => void downloadNotFoundCsv()}
            className="inline-flex items-center gap-1 px-2.5 py-1.5 text-[11px] font-medium text-amber-900 bg-amber-50 border border-amber-200 rounded-lg hover:bg-amber-100"
          >
            <Download className="w-3 h-3" />
            CSV não encontrados ({notFoundItems.length.toLocaleString('pt-BR')})
          </button>
        )}
        <button
          type="button"
          disabled={marking || eligible === 0}
          onClick={() => void markAllWithoutDownload()}
          className="inline-flex items-center gap-1 px-2.5 py-1.5 text-[11px] font-medium text-gray-700 dark:text-slate-200 bg-white dark:bg-slate-800/60 border border-gray-200 dark:border-slate-700 rounded-lg hover:bg-gray-50 dark:hover:bg-slate-800 disabled:opacity-50"
          title="Use depois de enviar mensagens por outro canal"
        >
          {marking ? (
            <Loader2 className="w-3 h-3 animate-spin" />
          ) : (
            <CheckCircle2 className="w-3 h-3" />
          )}
          Registrar como ativados
        </button>
      </div>
      {origemBlocked && (
        <div
          role="alert"
          className="rounded-lg border border-amber-300 bg-amber-50 px-3 py-2.5 text-[11px] text-amber-950 leading-snug"
        >
          <p className="font-semibold flex items-center gap-1.5">
            <AlertTriangle className="w-3.5 h-3.5 shrink-0" />
            Disparo interrompido — respostas não serão mensuradas
          </p>
          <p className="mt-1">{origemBlocked}</p>
          <p className="mt-1 text-amber-900/80">
            Corrija a gravação do campo <strong>origem_ativacao</strong> no DataCrazy antes de
            continuar. Sem esse campo, a automação não envia cliques para o n8n/planilha de
            respondidos.
          </p>
        </div>
      )}
      <LoadingOverlay
        open={running && !overlayMinimized}
        title={`Disparando campanha — ${CATEGORY_LABEL[category]}`}
        subtitle="Sincronizando com o DataCrazy, enviando templates do WhatsApp e gravando histórico no banco."
        hint={`Pode levar até ${estMinutes} min em filas grandes. Você pode minimizar — a operação continua em segundo plano.`}
        stages={[
          'Buscando alunos no DataCrazy',
          'Enviando templates via WhatsApp',
          'Registrando histórico',
        ]}
        currentStageIndex={0}
        onClose={() => setOverlayMinimized(true)}
        progress={progress ?? undefined}
      />
      {batch && !running && (
        <p className="text-[10px] text-emerald-700">
          Concluído: {batch.sent.toLocaleString('pt-BR')} enviada(s),{' '}
          {batch.not_found.toLocaleString('pt-BR')} não encontrada(s), {batch.failed.toLocaleString('pt-BR')}{' '}
          falha(s), {batch.skipped.toLocaleString('pt-BR')} ignorada(s) (template já enviado)
          {batch.pages != null && (
            <>
              {' '}
              · {batch.pages} páginas / {batch.scanned?.toLocaleString('pt-BR')} leads
            </>
          )}
        </p>
      )}
      {error && <p className="text-[10px] text-rose-600">{error}</p>}
    </div>
  );
}
