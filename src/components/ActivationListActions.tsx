import { useCallback, useState } from 'react';
import { Download, Zap, Loader2, CheckCircle2, AlertTriangle } from 'lucide-react';
import {
  activationApi,
  type ActivationCategory,
  type DatacrazyBatchNotFoundItem,
} from '../services/activationApi';
import { useConsultor } from '../hooks/useConsultor';

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
};

export function ActivationListActions({
  category,
  label,
  total,
  onFilaChanged,
  selectedMasterKeys,
  onClearSelection,
}: Props) {
  const { ensure: ensureConsultor } = useConsultor();
  const selectedCount = selectedMasterKeys?.length ?? 0;
  const hasSelection = selectedCount > 0;
  const [running, setRunning] = useState(false);
  const eligible = total;
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
      ? `Disparar template para ${selectedCount} aluno(s) SELECIONADO(S) em «${CATEGORY_LABEL[category]}»?\n\nEsta ação envia mensagens WhatsApp reais.`
      : `Buscar no DataCrazy e enviar mensagem de ativação para até ${eligible.toLocaleString('pt-BR')} pessoa(s) em «${CATEGORY_LABEL[category]}»?\n\n` +
        'A mensagem muda na 1ª ativação e na 5ª (templates no .env). Quem não for encontrado entra na lista para CSV.';
    const ok = window.confirm(confirmMsg);
    if (!ok) return;

    const consultor = ensureConsultor();
    if (!consultor) {
      setError('É preciso informar seu nome para registrar o disparo no painel "Por consultor".');
      return;
    }

    setRunning(true);
    setError(null);
    setOrigemBlocked(null);
    setBatch(null);
    setNotFoundItems([]);

    try {
      const result = await activationApi.runDatacrazyBatch(
        category,
        hasSelection ? { masterKeys: selectedMasterKeys } : undefined
      );
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
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Erro ao buscar e ativar no DataCrazy');
    } finally {
      setRunning(false);
    }
  }, [category, eligible, hasSelection, selectedCount, selectedMasterKeys, onFilaChanged, onClearSelection]);

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

  const estMinutes = Math.max(Math.ceil(eligible / 80), 3);

  return (
    <div className="mt-3 pt-3 border-t border-rose-100 space-y-2">
      <p className="text-[11px] text-rose-800/90 font-medium">Ativação — {label}</p>
      <p className="text-[10px] text-gray-500 leading-snug">
        <strong className="text-gray-800">{eligible.toLocaleString('pt-BR')}</strong> na interseção
        (matrícula × base, conforme Relatórios). A tabela abaixo pode levar ~1 min na 1ª abertura.
      </p>
      <p className="text-[10px] text-gray-500 leading-snug">
        Docs, inadimplentes, Blackboard e CAA são independentes. Na <strong>mesma</strong> campanha, a mensagem muda na 1ª
        ativação e na 5ª (não envia o mesmo template duas vezes).
      </p>
      <p className="text-[10px] text-gray-500 leading-snug">
        Escolha os templates na seção acima (mesma lista do Disparo manual). «Buscar e ativar» localiza
        no DataCrazy e dispara o template na hora (estimativa ~{estMinutes} min para filas grandes).
      </p>
      <div className="flex flex-wrap gap-2">
        <button
          type="button"
          disabled={marking || eligible === 0}
          onClick={() => void downloadListCsv()}
          className="inline-flex items-center gap-1 px-2.5 py-1.5 text-[11px] font-medium text-gray-700 bg-white border border-gray-200 rounded-lg hover:bg-gray-50 disabled:opacity-50"
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
            className="inline-flex items-center gap-1 px-2.5 py-1.5 text-[11px] font-medium text-gray-700 bg-white border border-gray-200 rounded-lg hover:bg-gray-50"
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
          className="inline-flex items-center gap-1 px-2.5 py-1.5 text-[11px] font-medium text-emerald-800 bg-emerald-50 border border-emerald-200 rounded-lg hover:bg-emerald-100 disabled:opacity-50"
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
      {running && (
        <p className="text-[10px] text-gray-600">
          Sincronizando DataCrazy, enviando templates e registrando histórico…
        </p>
      )}
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
