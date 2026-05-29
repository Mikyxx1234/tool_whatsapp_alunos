import { useCallback, useEffect, useState } from 'react';
import { PlusCircle, Trash2, Paperclip, ChevronLeft, ChevronRight, ChevronDown, RefreshCw } from 'lucide-react';
import { Header } from '../components/Header';
import { ManualOutcomeModal } from '../components/ManualOutcomeModal';
import {
  manualOutcomesApi,
  type ManualOutcomeDTO,
  type ManualOutcomeFilters,
  type OutcomeKind,
} from '../services/manualOutcomesApi';
import type { ActivationCategory } from '../services/activationApi';

const PAGE_SIZE = 100;

const CATEGORY_LABELS: Record<ActivationCategory, string> = {
  'docs-pendentes': 'Docs pendentes',
  financeiro: 'Financeiro',
  'acessos-blackboard': 'Blackboard',
  'processos-caa': 'Processo CAA',
  'provavel-evasao': 'Provável evasão',
  'aguardando-inicio': 'Aguardando início',
};

const OUTCOME_LABELS: Record<OutcomeKind, string> = {
  revertido: 'Revertido',
  confirmado: 'Confirmado',
  sem_contato: 'Sem contato',
  outro: 'Outro',
};

const OUTCOME_COLORS: Record<OutcomeKind, string> = {
  revertido: 'bg-emerald-50 text-emerald-700 border-emerald-200',
  confirmado: 'bg-rose-50 text-rose-700 border-rose-200',
  sem_contato: 'bg-gray-50 text-gray-600 border-gray-200',
  outro: 'bg-amber-50 text-amber-700 border-amber-200',
};

const CATEGORIES: Array<{ value: ActivationCategory | ''; label: string }> = [
  { value: '', label: 'Todas as categorias' },
  { value: 'processos-caa', label: 'Processo CAA' },
  { value: 'docs-pendentes', label: 'Docs pendentes' },
  { value: 'financeiro', label: 'Financeiro' },
  { value: 'acessos-blackboard', label: 'Blackboard' },
  { value: 'provavel-evasao', label: 'Provável evasão' },
  { value: 'aguardando-inicio', label: 'Aguardando início' },
];

const OUTCOMES: Array<{ value: OutcomeKind | ''; label: string }> = [
  { value: '', label: 'Todos os desfechos' },
  { value: 'revertido', label: 'Revertido' },
  { value: 'confirmado', label: 'Confirmado' },
  { value: 'sem_contato', label: 'Sem contato' },
  { value: 'outro', label: 'Outro' },
];

function fmtDate(iso: string): string {
  try {
    return new Date(iso).toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short' });
  } catch {
    return iso;
  }
}

function fmtBytes(n: number | null): string {
  if (n == null) return '';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

export default function ManualOutcomesPage() {
  const [items, setItems] = useState<ManualOutcomeDTO[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [page, setPage] = useState(0);
  const [hasMore, setHasMore] = useState(false);

  const [filterCategory, setFilterCategory] = useState<ActivationCategory | ''>('');
  const [filterOutcome, setFilterOutcome] = useState<OutcomeKind | ''>('');
  const [filterConsultor, setFilterConsultor] = useState('');
  const [filterFrom, setFilterFrom] = useState('');
  const [filterTo, setFilterTo] = useState('');
  const [filterSearch, setFilterSearch] = useState('');

  const [modalOpen, setModalOpen] = useState(false);
  const [deletingId, setDeletingId] = useState<string | null>(null);

  const load = useCallback(
    async (pageIndex: number) => {
      setLoading(true);
      setError(null);
      try {
        const filters: ManualOutcomeFilters = {
          limit: PAGE_SIZE + 1,
          offset: pageIndex * PAGE_SIZE,
        };
        if (filterCategory) filters.category = filterCategory;
        if (filterOutcome) filters.outcome = filterOutcome;
        if (filterConsultor.trim()) filters.consultor = filterConsultor.trim();
        if (filterFrom) filters.from = new Date(filterFrom).toISOString();
        if (filterTo) filters.to = new Date(filterTo + 'T23:59:59').toISOString();
        if (filterSearch.trim()) filters.search = filterSearch.trim();

        const { items: rows } = await manualOutcomesApi.list(filters);
        setHasMore(rows.length > PAGE_SIZE);
        setItems(rows.slice(0, PAGE_SIZE));
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Erro ao carregar desfechos');
        setItems([]);
      } finally {
        setLoading(false);
      }
    },
    [filterCategory, filterOutcome, filterConsultor, filterFrom, filterTo, filterSearch]
  );

  useEffect(() => {
    setPage(0);
  }, [filterCategory, filterOutcome, filterConsultor, filterFrom, filterTo, filterSearch]);

  useEffect(() => {
    void load(page);
  }, [load, page]);

  const handleDelete = async (id: string) => {
    if (!window.confirm('Excluir este desfecho permanentemente?')) return;
    setDeletingId(id);
    try {
      await manualOutcomesApi.delete(id);
      void load(page);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Erro ao excluir');
    } finally {
      setDeletingId(null);
    }
  };

  return (
    <div className="min-h-screen bg-gray-50">
      <Header showHistoryButton={false} />
      <main className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8 space-y-6">
        <div className="flex items-end justify-between flex-wrap gap-3">
          <div>
            <h2 className="text-2xl font-semibold text-gray-900">Desfechos Manuais</h2>
            <p className="text-sm text-gray-500 mt-0.5">Registro de resultados de atendimentos por consultores</p>
          </div>
          <button
            type="button"
            onClick={() => setModalOpen(true)}
            className="inline-flex items-center gap-2 px-4 py-2 text-sm font-medium text-white bg-whatsapp-500 hover:bg-whatsapp-600 rounded-lg transition-colors"
          >
            <PlusCircle className="w-4 h-4" />
            Novo registro
          </button>
        </div>

        <div className="bg-white rounded-xl border border-gray-100 shadow-sm p-4">
          <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-3">
            <div className="relative">
              <select
                value={filterCategory}
                onChange={(e) => setFilterCategory(e.target.value as ActivationCategory | '')}
                className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm appearance-none pr-8 focus:outline-none focus:ring-2 focus:ring-whatsapp-500"
              >
                {CATEGORIES.map((c) => (
                  <option key={c.value} value={c.value}>{c.label}</option>
                ))}
              </select>
              <ChevronDown className="absolute right-2 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400 pointer-events-none" />
            </div>

            <div className="relative">
              <select
                value={filterOutcome}
                onChange={(e) => setFilterOutcome(e.target.value as OutcomeKind | '')}
                className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm appearance-none pr-8 focus:outline-none focus:ring-2 focus:ring-whatsapp-500"
              >
                {OUTCOMES.map((o) => (
                  <option key={o.value} value={o.value}>{o.label}</option>
                ))}
              </select>
              <ChevronDown className="absolute right-2 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400 pointer-events-none" />
            </div>

            <input
              type="text"
              value={filterSearch}
              onChange={(e) => setFilterSearch(e.target.value)}
              placeholder="Buscar RGM ou nome…"
              className="border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-whatsapp-500"
            />

            <input
              type="text"
              value={filterConsultor}
              onChange={(e) => setFilterConsultor(e.target.value)}
              placeholder="Consultor…"
              className="border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-whatsapp-500"
            />

            <input
              type="date"
              value={filterFrom}
              onChange={(e) => setFilterFrom(e.target.value)}
              className="border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-whatsapp-500"
              title="De"
            />

            <input
              type="date"
              value={filterTo}
              onChange={(e) => setFilterTo(e.target.value)}
              className="border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-whatsapp-500"
              title="Até"
            />
          </div>
        </div>

        <div className="bg-white rounded-xl border border-gray-100 shadow-sm overflow-hidden">
          <div className="px-4 py-3 border-b border-gray-100 flex items-center justify-between gap-2 text-xs text-gray-500">
            <span>
              {loading ? 'Carregando…' : items.length === 0 ? 'Nenhum desfecho registrado' : `${items.length} registro(s) nesta página`}
            </span>
            <button
              type="button"
              onClick={() => void load(page)}
              className="inline-flex items-center gap-1 text-whatsapp-700 hover:underline"
            >
              <RefreshCw className="w-3 h-3" />
              Atualizar
            </button>
          </div>

          {error && (
            <div className="mx-4 mt-3 text-xs text-rose-700 bg-rose-50 border border-rose-100 rounded-lg px-3 py-2">
              {error}
            </div>
          )}

          <div className="overflow-x-auto">
            <table className="min-w-full text-sm">
              <thead className="bg-gray-50 text-gray-600">
                <tr>
                  <th className="px-3 py-2 text-left font-medium">Aluno / RGM</th>
                  <th className="px-3 py-2 text-left font-medium">Categoria</th>
                  <th className="px-3 py-2 text-left font-medium">Protocolo</th>
                  <th className="px-3 py-2 text-left font-medium">Desfecho</th>
                  <th className="px-3 py-2 text-left font-medium">Motivo</th>
                  <th className="px-3 py-2 text-left font-medium">Consultor</th>
                  <th className="px-3 py-2 text-left font-medium">Data</th>
                  <th className="px-3 py-2 text-left font-medium">Anexo</th>
                  <th className="px-3 py-2" />
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {loading ? (
                  <tr>
                    <td colSpan={9} className="px-3 py-8 text-center text-gray-500 text-xs">
                      Carregando…
                    </td>
                  </tr>
                ) : items.length === 0 ? (
                  <tr>
                    <td colSpan={9} className="px-3 py-8 text-center text-gray-500 text-xs">
                      Nenhum registro encontrado. Use o botão "Novo registro" para começar.
                    </td>
                  </tr>
                ) : (
                  items.map((row) => (
                    <tr key={row.id} className="hover:bg-gray-50/60">
                      <td className="px-3 py-2">
                        <div className="font-medium text-gray-900">{row.nome || '—'}</div>
                        {row.rgm && <div className="text-xs font-mono text-gray-500">{row.rgm}</div>}
                      </td>
                      <td className="px-3 py-2 text-xs text-gray-600">
                        {CATEGORY_LABELS[row.category] ?? row.category}
                      </td>
                      <td className="px-3 py-2 text-xs font-mono text-gray-600">
                        {row.protocolo || '—'}
                      </td>
                      <td className="px-3 py-2">
                        <span className={`inline-flex items-center px-2 py-0.5 text-[11px] font-medium rounded-full border ${OUTCOME_COLORS[row.outcome]}`}>
                          {OUTCOME_LABELS[row.outcome] ?? row.outcome}
                        </span>
                      </td>
                      <td className="px-3 py-2 text-xs text-gray-600 max-w-[160px] truncate" title={row.motivo ?? ''}>
                        {row.motivo || '—'}
                      </td>
                      <td className="px-3 py-2 text-xs text-gray-600">{row.consultor_nome}</td>
                      <td className="px-3 py-2 text-xs text-gray-600 whitespace-nowrap">
                        {fmtDate(row.occurred_at)}
                      </td>
                      <td className="px-3 py-2 text-xs">
                        {row.has_proof ? (
                          <a
                            href={manualOutcomesApi.proofUrl(row.id)}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="inline-flex items-center gap-1 text-whatsapp-700 hover:underline"
                            title={row.proof_mime && row.proof_size_bytes != null ? `${row.proof_mime} · ${fmtBytes(row.proof_size_bytes)}` : 'Ver anexo'}
                          >
                            <Paperclip className="w-3.5 h-3.5" />
                            Ver
                          </a>
                        ) : (
                          <span className="text-gray-400">—</span>
                        )}
                      </td>
                      <td className="px-3 py-2">
                        <button
                          type="button"
                          onClick={() => void handleDelete(row.id)}
                          disabled={deletingId === row.id}
                          className="p-1 text-gray-400 hover:text-rose-600 rounded hover:bg-rose-50 transition-colors disabled:opacity-40"
                          title="Excluir registro"
                        >
                          <Trash2 className="w-4 h-4" />
                        </button>
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>

          {(page > 0 || hasMore) && (
            <div className="px-4 py-3 border-t border-gray-100 flex items-center justify-between bg-gray-50/50">
              <span className="text-xs text-gray-600">
                Página {page + 1} · {PAGE_SIZE} por página
              </span>
              <div className="flex items-center gap-1">
                <button
                  type="button"
                  disabled={loading || page <= 0}
                  onClick={() => setPage((p) => Math.max(0, p - 1))}
                  className="inline-flex items-center gap-1 px-2.5 py-1.5 text-xs font-medium text-gray-700 bg-white border border-gray-200 rounded-lg hover:bg-gray-50 disabled:opacity-40"
                >
                  <ChevronLeft className="w-3.5 h-3.5" />
                  Anterior
                </button>
                <button
                  type="button"
                  disabled={loading || !hasMore}
                  onClick={() => setPage((p) => p + 1)}
                  className="inline-flex items-center gap-1 px-2.5 py-1.5 text-xs font-medium text-gray-700 bg-white border border-gray-200 rounded-lg hover:bg-gray-50 disabled:opacity-40"
                >
                  Próxima
                  <ChevronRight className="w-3.5 h-3.5" />
                </button>
              </div>
            </div>
          )}
        </div>
      </main>

      <ManualOutcomeModal
        isOpen={modalOpen}
        onClose={() => setModalOpen(false)}
        onSaved={() => void load(page)}
      />
    </div>
  );
}
