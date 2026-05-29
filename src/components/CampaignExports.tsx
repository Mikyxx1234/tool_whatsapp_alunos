import { useCallback, useEffect, useState } from 'react';
import {
  Download,
  PhoneOff,
  XCircle,
  Copy,
  AlertTriangle,
  RefreshCw,
} from 'lucide-react';
import {
  campaignApi,
  type ExportCategory,
  type ExportCounts,
} from '../services/campaignApi';

interface CampaignExportsProps {
  campaignId: string | null;
  campaignName?: string | null;
  /** Trigger de refresh externo (ex: progresso atualizou). */
  refreshKey?: number;
  onError?: (message: string) => void;
}

const ZERO: ExportCounts = {
  invalid: 0,
  duplicate: 0,
  failed: 0,
  not_on_whatsapp: 0,
  sent: 0,
};

function slug(name: string | null | undefined, fallback: string) {
  return (name || fallback)
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-zA-Z0-9]+/g, '_')
    .toLowerCase();
}

export function CampaignExports({
  campaignId,
  campaignName,
  refreshKey = 0,
  onError,
}: CampaignExportsProps) {
  const [counts, setCounts] = useState<ExportCounts>(ZERO);
  const [loading, setLoading] = useState(false);
  const [downloading, setDownloading] = useState<ExportCategory | null>(null);

  const fetchCounts = useCallback(async () => {
    if (!campaignId) {
      setCounts(ZERO);
      return;
    }
    setLoading(true);
    try {
      const data = await campaignApi.getExportCounts(campaignId);
      setCounts(data);
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Erro ao carregar contagens';
      onError?.(msg);
    } finally {
      setLoading(false);
    }
  }, [campaignId, onError]);

  useEffect(() => {
    fetchCounts();
  }, [fetchCounts, refreshKey]);

  const handleDownload = useCallback(
    async (categories: ExportCategory[], label: string) => {
      if (!campaignId) return;
      setDownloading(categories[0]);
      try {
        const fileName = `disparo_${slug(campaignName, campaignId)}_${label}.csv`;
        await campaignApi.downloadExport(campaignId, categories, fileName);
      } catch (err) {
        const msg = err instanceof Error ? err.message : 'Erro ao exportar';
        onError?.(msg);
      } finally {
        setDownloading(null);
      }
    },
    [campaignId, campaignName, onError]
  );

  if (!campaignId) return null;

  const totalExportavel =
    counts.invalid + counts.duplicate + counts.failed;

  const cards: {
    key: ExportCategory;
    title: string;
    description: string;
    count: number;
    icon: typeof XCircle;
    color: string;
    border: string;
    button: string;
    fileLabel: string;
    highlight?: boolean;
  }[] = [
    {
      key: 'not_on_whatsapp',
      title: 'Sem WhatsApp',
      description: 'Leads que o provedor não encontrou no WhatsApp.',
      count: counts.not_on_whatsapp,
      icon: PhoneOff,
      color: 'text-orange-600',
      border: 'border-orange-200 bg-orange-50/50',
      button:
        'bg-orange-600 hover:bg-orange-700 text-white disabled:bg-orange-300',
      fileLabel: 'sem_whatsapp',
      highlight: true,
    },
    {
      key: 'failed',
      title: 'Falhas no envio',
      description: 'Inclui números sem WhatsApp e outros erros do provedor.',
      count: counts.failed,
      icon: AlertTriangle,
      color: 'text-red-600',
      border: 'border-red-200 bg-red-50/50',
      button: 'bg-red-600 hover:bg-red-700 text-white disabled:bg-red-300',
      fileLabel: 'falhas',
    },
    {
      key: 'invalid',
      title: 'Inválidos no CSV',
      description: 'Telefones com formato inválido detectados na importação.',
      count: counts.invalid,
      icon: XCircle,
      color: 'text-rose-600',
      border: 'border-rose-200 bg-rose-50/50',
      button:
        'bg-rose-600 hover:bg-rose-700 text-white disabled:bg-rose-300',
      fileLabel: 'invalidos',
    },
    {
      key: 'duplicate',
      title: 'Duplicados',
      description: 'Mesmo telefone aparecendo mais de uma vez no CSV.',
      count: counts.duplicate,
      icon: Copy,
      color: 'text-amber-600',
      border: 'border-amber-200 bg-amber-50/50',
      button:
        'bg-amber-600 hover:bg-amber-700 text-white disabled:bg-amber-300',
      fileLabel: 'duplicados',
    },
  ];

  return (
    <div className="bg-white rounded-2xl border border-gray-100 p-6 shadow-sm">
      <div className="flex items-center justify-between mb-1">
        <h2 className="text-lg font-semibold text-gray-900">
          Leads não alcançados
        </h2>
        <button
          type="button"
          onClick={fetchCounts}
          disabled={loading}
          className="inline-flex items-center gap-1 text-xs text-gray-500 hover:text-gray-800 disabled:opacity-50"
          title="Atualizar contagens"
        >
          <RefreshCw className={`w-3.5 h-3.5 ${loading ? 'animate-spin' : ''}`} />
          Atualizar
        </button>
      </div>
      <p className="text-sm text-gray-500 mb-4">
        {totalExportavel === 0
          ? 'Nenhuma falha registrada ainda. As contagens atualizam em tempo real.'
          : `${totalExportavel} contato(s) não receberam a mensagem. Exporte para acompanhar.`}
      </p>

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        {cards.map((card) => {
          const Icon = card.icon;
          const isDownloading = downloading === card.key;
          const disabled = card.count === 0 || isDownloading;
          return (
            <div
              key={card.key}
              className={`rounded-xl border p-4 flex flex-col justify-between ${card.border} ${
                card.highlight ? 'ring-1 ring-orange-200' : ''
              }`}
            >
              <div>
                <div className="flex items-center justify-between mb-2">
                  <div className="flex items-center gap-2">
                    <Icon className={`w-4 h-4 ${card.color}`} />
                    <span className="text-sm font-semibold text-gray-900">
                      {card.title}
                    </span>
                  </div>
                  <span className={`text-2xl font-bold ${card.color}`}>
                    {card.count}
                  </span>
                </div>
                <p className="text-xs text-gray-600 mb-3">{card.description}</p>
              </div>
              <button
                type="button"
                onClick={() => handleDownload([card.key], card.fileLabel)}
                disabled={disabled}
                className={`w-full inline-flex items-center justify-center gap-2 rounded-lg px-3 py-2 text-xs font-medium transition ${card.button} disabled:cursor-not-allowed`}
              >
                <Download className="w-3.5 h-3.5" />
                {isDownloading ? 'Gerando CSV...' : 'Exportar CSV'}
              </button>
            </div>
          );
        })}
      </div>
    </div>
  );
}
