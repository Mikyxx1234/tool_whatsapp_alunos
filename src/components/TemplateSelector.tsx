import { Loader2, AlertCircle, FileCheck, RefreshCw, Search, Plus, Check } from 'lucide-react';
import { useMemo, useState } from 'react';
import type { WhatsAppTemplate } from '../types';
import { getTemplateBodyText } from '../utils/templateVariables';

interface TemplateSelectorProps {
  templates: WhatsAppTemplate[];
  selectedTemplateName: string | null;
  onSelectTemplate: (name: string) => void;
  loading: boolean;
  error: string | null;
  onReload: () => void;
  onCreateClick: () => void;
}

type CategoryFilter = 'ALL' | 'MARKETING' | 'UTILITY';

export function TemplateSelector({
  templates,
  selectedTemplateName,
  onSelectTemplate,
  loading,
  error,
  onReload,
  onCreateClick,
}: TemplateSelectorProps) {
  const [search, setSearch] = useState('');
  const [categoryFilter, setCategoryFilter] = useState<CategoryFilter>('ALL');

  const approved = useMemo(
    () => templates.filter((t) => (t.status || '').toUpperCase() === 'APPROVED'),
    [templates]
  );

  const filtered = useMemo(() => {
    const term = search.trim().toLowerCase();
    return approved.filter((t) => {
      if (categoryFilter !== 'ALL' && (t.category || '').toUpperCase() !== categoryFilter) {
        return false;
      }
      if (term) {
        const haystack = `${t.name} ${t.language} ${t.category}`.toLowerCase();
        if (!haystack.includes(term)) return false;
      }
      return true;
    });
  }, [approved, categoryFilter, search]);

  const selected = approved.find((t) => t.name === selectedTemplateName) || null;
  const bodyText = getTemplateBodyText(selected);

  return (
    <div className="bg-white rounded-2xl border border-gray-100 p-6 shadow-sm">
      <div className="flex items-center justify-between mb-4 gap-3">
        <h2 className="text-lg font-semibold text-gray-900 flex items-center gap-2">
          <FileCheck className="w-5 h-5 text-gray-500" />
          Template aprovado
          <span className="text-xs font-normal text-gray-400">({approved.length})</span>
        </h2>
        <div className="flex items-center gap-2">
          <button
            onClick={onCreateClick}
            className="inline-flex items-center gap-1.5 px-2.5 py-1.5 text-xs font-medium text-white bg-whatsapp-500 hover:bg-whatsapp-600 rounded-lg transition-colors"
          >
            <Plus className="w-3.5 h-3.5" />
            Novo template
          </button>
          <button
            onClick={onReload}
            disabled={loading}
            className="inline-flex items-center gap-1.5 px-2.5 py-1.5 text-xs font-medium text-gray-600 bg-white border border-gray-200 rounded-lg hover:bg-gray-50 transition-colors disabled:opacity-50"
          >
            <RefreshCw className={`w-3.5 h-3.5 ${loading ? 'animate-spin' : ''}`} />
            Recarregar
          </button>
        </div>
      </div>

      {loading && (
        <div className="flex items-center gap-2 px-3 py-3 bg-gray-50 rounded-lg text-sm text-gray-500">
          <Loader2 className="w-4 h-4 animate-spin" />
          Buscando templates...
        </div>
      )}

      {!loading && error && (
        <div className="flex items-start gap-2 p-3 bg-red-50 border border-red-100 rounded-lg">
          <AlertCircle className="w-4 h-4 text-red-500 flex-shrink-0 mt-0.5" />
          <div>
            <p className="text-sm font-medium text-red-700">Falha ao carregar templates</p>
            <p className="text-xs text-red-600 mt-0.5 break-words">{error}</p>
          </div>
        </div>
      )}

      {!loading && !error && (
        <>
          <div className="flex flex-col sm:flex-row gap-2 mb-3">
            <div className="relative flex-1">
              <Search className="w-4 h-4 text-gray-400 absolute left-3 top-1/2 -translate-y-1/2" />
              <input
                type="text"
                placeholder="Buscar template por nome, idioma..."
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                className="w-full pl-9 pr-3 py-2 text-sm border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-whatsapp-500/20 focus:border-whatsapp-500"
              />
            </div>
            <div className="flex gap-1 bg-gray-50 p-1 rounded-lg">
              {(['ALL', 'MARKETING', 'UTILITY'] as CategoryFilter[]).map((cat) => (
                <button
                  key={cat}
                  onClick={() => setCategoryFilter(cat)}
                  className={`px-2.5 py-1.5 text-xs font-medium rounded-md transition-colors ${
                    categoryFilter === cat
                      ? 'bg-white text-gray-900 shadow-sm'
                      : 'text-gray-500 hover:text-gray-700'
                  }`}
                >
                  {cat === 'ALL' ? 'Todos' : cat === 'MARKETING' ? 'Marketing' : 'Utility'}
                </button>
              ))}
            </div>
          </div>

          <div className="max-h-64 overflow-y-auto rounded-xl border border-gray-100 divide-y divide-gray-50">
            {filtered.length === 0 ? (
              <div className="px-4 py-6 text-center text-sm text-gray-400">
                Nenhum template encontrado.
              </div>
            ) : (
              filtered.map((t) => {
                const isSelected = t.name === selectedTemplateName;
                return (
                  <button
                    key={t.id}
                    onClick={() => onSelectTemplate(t.name)}
                    className={`w-full text-left px-3 py-2.5 hover:bg-gray-50 transition-colors flex items-center gap-3 ${
                      isSelected ? 'bg-emerald-50/60' : ''
                    }`}
                  >
                    <div
                      className={`w-5 h-5 rounded-full flex items-center justify-center flex-shrink-0 ${
                        isSelected ? 'bg-emerald-500 text-white' : 'border border-gray-200'
                      }`}
                    >
                      {isSelected && <Check className="w-3 h-3" />}
                    </div>
                    <div className="flex-1 min-w-0">
                      <p className="text-sm font-medium text-gray-900 truncate">{t.name}</p>
                      <p className="text-[11px] text-gray-500 uppercase tracking-wide">
                        {t.category} · {t.language}
                      </p>
                    </div>
                  </button>
                );
              })
            )}
          </div>

          {selected && (
            <div className="mt-3 p-3 bg-emerald-50 border border-emerald-100 rounded-lg">
              <div className="flex items-center justify-between mb-1">
                <p className="text-xs font-medium text-emerald-700">{selected.name}</p>
                <span className="text-[10px] uppercase tracking-wide text-emerald-600">
                  {selected.category} · {selected.language}
                </span>
              </div>
              {bodyText ? (
                <p className="text-xs text-emerald-800 whitespace-pre-wrap leading-relaxed">
                  {bodyText}
                </p>
              ) : (
                <p className="text-xs text-emerald-700/70">
                  Template sem corpo de texto detectável.
                </p>
              )}
            </div>
          )}
        </>
      )}
    </div>
  );
}
