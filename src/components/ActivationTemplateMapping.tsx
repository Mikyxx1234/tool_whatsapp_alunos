import { useCallback, useEffect, useMemo, useState } from 'react';
import { FileCheck, Loader2, RefreshCw, Search } from 'lucide-react';
import { apiClient } from '../services/apiClient';
import {
  activationApi,
  type ActivationCategory,
  type ActivationTemplateConfigMap,
} from '../services/activationApi';
import type { WhatsAppTemplate } from '../types';

const TIERS: { key: 'first' | 'repeat' | 'fifth'; label: string; hint: string }[] = [
  { key: 'first', label: '1ª ativação', hint: 'Nunca ativou nesta categoria' },
  { key: 'repeat', label: 'Reativação', hint: '2ª a 4ª vez' },
  { key: 'fifth', label: '5ª ativação', hint: 'Quinta vez ou mais' },
];

interface Props {
  category: ActivationCategory;
  categoryLabel: string;
  onSaved?: () => void;
}

export function ActivationTemplateMapping({ category, categoryLabel, onSaved }: Props) {
  const [templates, setTemplates] = useState<WhatsAppTemplate[]>([]);
  const [templatesLoading, setTemplatesLoading] = useState(true);
  const [templatesError, setTemplatesError] = useState<string | null>(null);
  const [config, setConfig] = useState<ActivationTemplateConfigMap>({});
  const [configLoading, setConfigLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [search, setSearch] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [savedHint, setSavedHint] = useState(false);

  const approved = useMemo(
    () => templates.filter((t) => (t.status || '').toUpperCase() === 'APPROVED'),
    [templates]
  );

  const filteredNames = useMemo(() => {
    const term = search.trim().toLowerCase();
    return approved
      .filter((t) => {
        if (!term) return true;
        return `${t.name} ${t.category} ${t.language}`.toLowerCase().includes(term);
      })
      .map((t) => t.name)
      .sort((a, b) => a.localeCompare(b, 'pt-BR'));
  }, [approved, search]);

  const loadTemplates = useCallback(async () => {
    setTemplatesLoading(true);
    setTemplatesError(null);
    try {
      const { templates: list } = await apiClient.listTemplates();
      setTemplates(list);
    } catch (e) {
      setTemplatesError(e instanceof Error ? e.message : 'Erro ao carregar templates');
    } finally {
      setTemplatesLoading(false);
    }
  }, []);

  const loadConfig = useCallback(async () => {
    setConfigLoading(true);
    try {
      const r = await activationApi.getTemplateConfig();
      setConfig(r.config);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Erro ao carregar configuração');
    } finally {
      setConfigLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadTemplates();
    void loadConfig();
  }, [loadTemplates, loadConfig]);

  const current = config[category] || {};

  const saveTier = useCallback(
    async (tier: 'first' | 'repeat' | 'fifth', value: string) => {
      setSaving(true);
      setError(null);
      setSavedHint(false);
      try {
        const patch = { [tier]: value || null };
        const r = await activationApi.setTemplateConfig(category, patch);
        setConfig(r.config);
        setSavedHint(true);
        onSaved?.();
        window.setTimeout(() => setSavedHint(false), 2500);
      } catch (e) {
        const msg = e instanceof Error ? e.message : 'Erro ao salvar template';
        setError(
          msg.includes('503') || msg.toLowerCase().includes('database')
            ? `${msg} — confira DATABASE_URL no .env e se o Postgres está acessível.`
            : msg
        );
      } finally {
        setSaving(false);
      }
    },
    [category, onSaved]
  );

  const busy = templatesLoading || configLoading;

  return (
    <div className="mt-4 rounded-xl border border-gray-200 bg-gray-50/80 p-4 space-y-3">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <h3 className="text-sm font-semibold text-gray-900 flex items-center gap-2">
            <FileCheck className="w-4 h-4 text-gray-500" />
            Templates — {categoryLabel}
          </h3>
          <p className="text-xs text-gray-500 mt-0.5 max-w-2xl">
            Mesma lista do <strong>Disparo manual</strong> (Meta/WhatsApp). Escolha um template
            aprovado para cada tipo de mensagem; vale para toda a fila desta aba.
          </p>
        </div>
        <button
          type="button"
          onClick={() => {
            void loadTemplates();
            void loadConfig();
          }}
          disabled={busy}
          className="inline-flex items-center gap-1 px-2 py-1 text-xs text-gray-600 border border-gray-200 rounded-lg bg-white hover:bg-gray-50 disabled:opacity-50"
        >
          <RefreshCw className={`w-3 h-3 ${busy ? 'animate-spin' : ''}`} />
          Recarregar
        </button>
      </div>

      {templatesError && (
        <p className="text-xs text-rose-600">{templatesError}</p>
      )}

      <div className="relative max-w-md">
        <Search className="w-3.5 h-3.5 text-gray-400 absolute left-2.5 top-1/2 -translate-y-1/2" />
        <input
          type="text"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Buscar template (nome, categoria…)"
          className="w-full pl-8 pr-2 py-1.5 text-xs border border-gray-200 rounded-lg bg-white"
        />
      </div>

      {busy ? (
        <div className="flex items-center gap-2 text-xs text-gray-500 py-2">
          <Loader2 className="w-3.5 h-3.5 animate-spin" />
          Carregando templates…
        </div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
          {TIERS.map((tier) => (
            <label key={tier.key} className="block text-xs">
              <span className="font-medium text-gray-800">{tier.label}</span>
              <span className="block text-[10px] text-gray-400 mb-1">{tier.hint}</span>
              <select
                value={current[tier.key] || ''}
                disabled={saving || approved.length === 0}
                onChange={(e) => void saveTier(tier.key, e.target.value)}
                className="w-full mt-0.5 text-xs border border-gray-200 rounded-lg px-2 py-2 bg-white focus:ring-2 focus:ring-whatsapp-500/20 focus:border-whatsapp-500"
              >
                <option value="">— Selecione um template —</option>
                {filteredNames.map((name) => (
                  <option key={name} value={name}>
                    {name}
                  </option>
                ))}
              </select>
            </label>
          ))}
        </div>
      )}

      {savedHint && (
        <p className="text-xs text-emerald-700">Templates salvos. A tabela abaixo foi atualizada.</p>
      )}
      {error && <p className="text-xs text-rose-600">{error}</p>}
      {!busy && approved.length === 0 && !templatesError && (
        <p className="text-xs text-amber-700">
          Nenhum template aprovado. Crie ou aguarde aprovação na Meta (ou use Recarregar no Disparo
          manual).
        </p>
      )}
    </div>
  );
}
