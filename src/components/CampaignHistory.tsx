import {
  Calendar,
  CheckCircle,
  XCircle,
  AlertTriangle,
  Loader2,
  RefreshCw,
  Clock,
  PauseCircle,
} from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import type { CampaignSummaryDB } from '../types';
import { campaignApi } from '../services/campaignApi';

const statusConfig: Record<
  string,
  { label: string; icon: typeof CheckCircle; class: string }
> = {
  draft: { label: 'Rascunho', icon: Clock, class: 'text-gray-600 bg-gray-50' },
  validating: { label: 'Validando', icon: Loader2, class: 'text-blue-600 bg-blue-50' },
  ready: { label: 'Pronta', icon: CheckCircle, class: 'text-emerald-600 bg-emerald-50' },
  sending: { label: 'Enviando', icon: Loader2, class: 'text-blue-600 bg-blue-50' },
  paused: { label: 'Pausada', icon: PauseCircle, class: 'text-amber-600 bg-amber-50' },
  cancelled: { label: 'Cancelada', icon: XCircle, class: 'text-gray-600 bg-gray-50' },
  completed: { label: 'Concluída', icon: CheckCircle, class: 'text-emerald-600 bg-emerald-50' },
  completed_with_errors: {
    label: 'Com erros',
    icon: AlertTriangle,
    class: 'text-amber-600 bg-amber-50',
  },
  failed: { label: 'Falhou', icon: XCircle, class: 'text-red-600 bg-red-50' },
};

function formatDate(iso: string | null): string {
  if (!iso) return '—';
  try {
    const d = new Date(iso);
    return d.toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short' });
  } catch {
    return iso;
  }
}

interface CampaignHistoryProps {
  visible: boolean;
  refreshKey?: number;
}

export function CampaignHistory({ visible, refreshKey = 0 }: CampaignHistoryProps) {
  const [items, setItems] = useState<CampaignSummaryDB[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const list = await campaignApi.list();
      setItems(list);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Erro desconhecido');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (visible) reload();
  }, [visible, refreshKey, reload]);

  if (!visible) return null;

  return (
    <div className="bg-white rounded-2xl border border-gray-100 p-6 shadow-sm">
      <div className="flex items-center justify-between mb-4">
        <h2 className="text-lg font-semibold text-gray-900 flex items-center gap-2">
          <Calendar className="w-5 h-5 text-gray-500" />
          Histórico de campanhas
        </h2>
        <button
          onClick={reload}
          disabled={loading}
          className="inline-flex items-center gap-1.5 px-2.5 py-1.5 text-xs font-medium text-gray-600 bg-white border border-gray-200 rounded-lg hover:bg-gray-50 transition-colors disabled:opacity-50"
        >
          <RefreshCw className={`w-3.5 h-3.5 ${loading ? 'animate-spin' : ''}`} />
          Recarregar
        </button>
      </div>

      {loading && items.length === 0 && (
        <div className="flex items-center gap-2 px-3 py-3 bg-gray-50 rounded-lg text-sm text-gray-500">
          <Loader2 className="w-4 h-4 animate-spin" />
          Carregando histórico...
        </div>
      )}

      {error && (
        <div className="p-3 bg-red-50 border border-red-100 rounded-lg text-xs text-red-700">
          {error}
        </div>
      )}

      {!loading && !error && items.length === 0 ? (
        <div className="text-center py-8 text-sm text-gray-400">
          Nenhuma campanha registrada ainda.
        </div>
      ) : null}

      {items.length > 0 && (
        <div className="overflow-x-auto rounded-xl border border-gray-100">
          <table className="w-full text-sm">
            <thead>
              <tr className="bg-gray-50">
                <th className="text-left py-3 px-4 font-medium text-gray-500">Nome</th>
                <th className="text-left py-3 px-4 font-medium text-gray-500">Tipo</th>
                <th className="text-left py-3 px-4 font-medium text-gray-500">Template</th>
                <th className="text-left py-3 px-4 font-medium text-gray-500">Criada em</th>
                <th className="text-right py-3 px-4 font-medium text-gray-500">Total</th>
                <th className="text-right py-3 px-4 font-medium text-gray-500">Enviadas</th>
                <th className="text-right py-3 px-4 font-medium text-gray-500">Falhas</th>
                <th className="text-right py-3 px-4 font-medium text-gray-500">Interagiu</th>
                <th className="text-right py-3 px-4 font-medium text-gray-500">% Interação</th>
                <th className="text-left py-3 px-4 font-medium text-gray-500">Status</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-50">
              {items.map((c) => {
                const cfg = statusConfig[c.status] || statusConfig.draft;
                const StatusIcon = cfg.icon;
                return (
                  <tr key={c.id} className="hover:bg-gray-50/50 transition-colors">
                    <td className="py-3 px-4 font-medium text-gray-900">{c.name}</td>
                    <td className="py-3 px-4 text-gray-600 text-xs">
                      {c.campaign_type_name || c.campaign_type || '—'}
                    </td>
                    <td className="py-3 px-4 text-gray-600 text-xs">{c.template_name || '—'}</td>
                    <td className="py-3 px-4 text-gray-500 text-xs">{formatDate(c.created_at)}</td>
                    <td className="py-3 px-4 text-right text-gray-600">
                      {c.total_contacts.toLocaleString()}
                    </td>
                    <td className="py-3 px-4 text-right text-emerald-600">
                      {c.total_sent.toLocaleString()}
                    </td>
                    <td className="py-3 px-4 text-right text-red-600">
                      {c.total_failed.toLocaleString()}
                    </td>
                    <td className="py-3 px-4 text-right text-blue-600">
                      {c.total_interacted.toLocaleString()}
                    </td>
                    <td className="py-3 px-4 text-right text-gray-700">
                      {Number(c.taxa_interacao || 0).toFixed(1)}%
                    </td>
                    <td className="py-3 px-4">
                      <span
                        className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-md text-xs font-medium ${cfg.class}`}
                      >
                        <StatusIcon
                          className={`w-3 h-3 ${
                            c.status === 'sending' || c.status === 'validating'
                              ? 'animate-spin'
                              : ''
                          }`}
                        />
                        {cfg.label}
                      </span>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      <p className="text-xs text-gray-400 mt-3 text-center">
        Dados em tempo real do banco (Postgres/Supabase).
      </p>
    </div>
  );
}
