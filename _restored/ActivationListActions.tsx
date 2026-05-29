import { useCallback, useState } from 'react';
import { Download, Search, Loader2 } from 'lucide-react';
import {
  activationApi,
  type ActivationCategory,
  type EnrichedActivationItem,
} from '../services/activationApi';

interface Props {
  category: ActivationCategory;
  label: string;
  total: number;
}

function downloadCsv(filename: string, rows: string[][]) {
  const esc = (v: string) => {
    const s = String(v ?? '');
    if (s.includes('"') || s.includes(',') || s.includes('\n')) {
      return `"${s.replace(/"/g, '""')}"`;
    }
    return s;
  };
  const header = [
    'nome',
    'email',
    'telefone',
    'rgm',
    'cpf',
    'polo',
    'curso',
    'datacrazy_id',
    'datacrazy_nome',
    'datacrazy_email',
    'datacrazy_telefone',
    'encontrado_datacrazy',
  ];
  const lines = [header.join(','), ...rows.map((r) => r.map(esc).join(','))];
  const blob = new Blob(['\uFEFF' + lines.join('\n')], {
    type: 'text/csv;charset=utf-8',
  });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

export function ActivationListActions({ category, label, total }: Props) {
  const [loadingDc, setLoadingDc] = useState(false);
  const [progress, setProgress] = useState<{
    done: number;
    found: number;
    notFound: number;
    pages?: number;
    scanned?: number;
  } | null>(null);
  const [enriched, setEnriched] = useState<EnrichedActivationItem[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const runDatacrazyLookup = useCallback(async () => {
    if (!total) return;
    setLoadingDc(true);
    setError(null);
    setEnriched([]);
    setProgress({ done: 0, found: 0, notFound: 0 });

    try {
      const batch = await activationApi.datacrazyEnrich(category, { limit: 0 });
      setEnriched(batch.results);
      setProgress({
        done: batch.total,
        found: batch.found,
        notFound: batch.not_found,
        pages: batch.datacrazy_pages,
        scanned: batch.datacrazy_leads_scanned,
      });
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Erro ao buscar no DataCrazy');
    } finally {
      setLoadingDc(false);
    }
  }, [category, total]);

  const exportEnriched = useCallback(() => {
    if (!enriched?.length) return;
    const rows = enriched.map((r) => [
      r.nome,
      r.email,
      r.telefone,
      r.rgm,
      r.cpf,
      r.polo,
      r.curso,
      r.datacrazy?.id ?? '',
      r.datacrazy?.name ?? '',
      r.datacrazy?.email ?? '',
      r.datacrazy?.phone ?? '',
      r.datacrazy_found ? 'sim' : 'nao',
    ]);
    downloadCsv(`ativacao-${category}-datacrazy.csv`, rows);
  }, [category, enriched]);

  const estPages = Math.ceil(total / 80);

  return (
    <div className="mt-3 pt-3 border-t border-rose-100 space-y-2">
      <p className="text-[11px] text-rose-800/90 font-medium">Ativação — {label}</p>
      <p className="text-[10px] text-gray-500 leading-snug">
        {total.toLocaleString('pt-BR')} pessoas nesta lista. O DataCrazy é consultado em{' '}
        <strong className="font-medium text-gray-700">páginas de leads</strong>, não 1 vez por aluno — o
        tempo não cresce na mesma proporção (ex.: 24 mil alunos ≠ 24 mil minutos). A 2ª lista reutiliza o
        índice já baixado. Estimativa: alguns minutos até ~{Math.max(estPages, 3)} min no pior caso.
      </p>
      <div className="flex flex-wrap gap-2">
        <a
          href={activationApi.exportCsvUrl(category)}
          download
          className="inline-flex items-center gap-1 px-2.5 py-1.5 text-[11px] font-medium text-gray-700 bg-white border border-gray-200 rounded-lg hover:bg-gray-50"
        >
          <Download className="w-3 h-3" />
          Baixar lista (CSV)
        </a>
        <button
          type="button"
          disabled={loadingDc || total === 0}
          onClick={() => void runDatacrazyLookup()}
          className="inline-flex items-center gap-1 px-2.5 py-1.5 text-[11px] font-medium text-white bg-whatsapp-600 rounded-lg hover:bg-whatsapp-700 disabled:opacity-50"
        >
          {loadingDc ? (
            <Loader2 className="w-3 h-3 animate-spin" />
          ) : (
            <Search className="w-3 h-3" />
          )}
          Buscar no DataCrazy
        </button>
        {enriched && enriched.length > 0 && (
          <button
            type="button"
            onClick={exportEnriched}
            className="inline-flex items-center gap-1 px-2.5 py-1.5 text-[11px] font-medium text-whatsapp-800 bg-whatsapp-50 border border-whatsapp-200 rounded-lg hover:bg-whatsapp-100"
          >
            <Download className="w-3 h-3" />
            CSV com DataCrazy
          </button>
        )}
      </motion.div>
      {loadingDc && (
        <p className="text-[10px] text-gray-600">
          Sincronizando páginas do DataCrazy e cruzando com a lista…
        </p>
      )}
      {progress && !loadingDc && enriched && (
        <p className="text-[10px] text-emerald-700">
          Concluído: {progress.found.toLocaleString('pt-BR')} no CRM,{' '}
          {progress.notFound.toLocaleString('pt-BR')} sem match
          {progress.pages != null && (
            <>
              {' '}
              · {progress.pages} páginas / {progress.scanned?.toLocaleString('pt-BR')} leads lidos
            </>
          )}
        </p>
      )}
      {error && <p className="text-[10px] text-rose-600">{error}</p>}
    </div>
  );
}
