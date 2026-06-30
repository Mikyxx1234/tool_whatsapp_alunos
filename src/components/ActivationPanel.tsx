import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { BarChart3 } from 'lucide-react';
import { ActivationListActions } from './ActivationListActions';
import { DatacrazyCacheSyncCard } from './DatacrazyCacheSyncCard';
import { ActivationRosterTable } from './ActivationRosterTable';
import { ActivationTemplateMapping } from './ActivationTemplateMapping';
import type { ActivationCategory } from '../services/activationApi';
import { activationApi } from '../services/activationApi';
import {
  isComparisonBuilding,
  reportApi,
  type MatriculadosComparisonBlock,
} from '../services/reportApi';

const CATEGORIES: { id: ActivationCategory; label: string; comparisonId: ActivationCategory }[] = [
  { id: 'docs-pendentes', label: 'Docs pendentes', comparisonId: 'docs-pendentes' },
  { id: 'financeiro', label: 'Inadimplentes', comparisonId: 'financeiro' },
  { id: 'provavel-evasao', label: 'Provável evasão', comparisonId: 'provavel-evasao' },
  {
    id: 'acessos-blackboard',
    label: 'Sem acesso BB',
    comparisonId: 'acessos-blackboard',
  },
  { id: 'processos-caa', label: 'CAA cancelamento', comparisonId: 'processos-caa' },
  { id: 'aguardando-inicio', label: 'Aguardando início', comparisonId: 'aguardando-inicio' },
  { id: 'conteudo-previo', label: 'Conteúdo prévio', comparisonId: 'conteudo-previo' },
  { id: 'rematricula', label: 'Rematrícula', comparisonId: 'rematricula' },
];

function activationQueueCount(
  blocks: MatriculadosComparisonBlock[] | undefined,
  id: ActivationCategory
) {
  const b = blocks?.find((x) => x.id === id);
  if (!b || b.missing_other) return 0;
  if (b.mode === 'other_is_coverage_list') {
    return b.matriculados_sem_intersecao;
  }
  return b.intersecao;
}

export function ActivationPanel() {
  const [category, setCategory] = useState<ActivationCategory>('docs-pendentes');
  const [intersectionByCat, setIntersectionByCat] = useState<Partial<Record<ActivationCategory, number>>>({});
  const [templateConfigVersion, setTemplateConfigVersion] = useState(0);
  const [selectedMasterKeys, setSelectedMasterKeys] = useState<Set<string>>(new Set());

  const clearSelection = useCallback(() => setSelectedMasterKeys(new Set()), []);
  const toggleSelection = useCallback((masterKey: string, checked: boolean) => {
    setSelectedMasterKeys((prev) => {
      const next = new Set(prev);
      if (checked) next.add(masterKey);
      else next.delete(masterKey);
      return next;
    });
  }, []);
  const toggleAllOnPage = useCallback((pageKeys: string[], checked: boolean) => {
    setSelectedMasterKeys((prev) => {
      const next = new Set(prev);
      for (const k of pageKeys) {
        if (checked) next.add(k);
        else next.delete(k);
      }
      return next;
    });
  }, []);
  const addSelectionMany = useCallback((keys: string[]) => {
    setSelectedMasterKeys((prev) => {
      const next = new Set(prev);
      for (const k of keys) next.add(k);
      return next;
    });
  }, []);
  const replaceSelection = useCallback((keys: string[]) => {
    setSelectedMasterKeys(new Set(keys));
  }, []);

  useEffect(() => {
    setSelectedMasterKeys(new Set());
  }, [category]);

  const selectedMasterKeysArr = useMemo(() => [...selectedMasterKeys], [selectedMasterKeys]);

  const label = useMemo(
    () => CATEGORIES.find((c) => c.id === category)?.label ?? category,
    [category]
  );

  const intersectionTotal = intersectionByCat[category] ?? 0;

  useEffect(() => {
    let cancelled = false;

    const overrideCaaCount = async (
      map: Partial<Record<ActivationCategory, number>>
    ) => {
      try {
        const caa = await reportApi.caaSummary();
        if (!cancelled) map['processos-caa'] = caa.current.open;
      } catch {
        /* sem painel D+1 — mantém o número do comparison */
      }
    };

    const overrideTermPhaseCounts = async (
      map: Partial<Record<ActivationCategory, number>>
    ) => {
      for (const cat of ['aguardando-inicio', 'conteudo-previo'] as const) {
        try {
          const r = await activationApi.roster(cat, { limit: 1, offset: 0 });
          if (!cancelled) map[cat] = r.total;
        } catch {
          /* depende de turmas no calendário */
        }
      }
    };

    const overrideRematriculaCount = async (
      map: Partial<Record<ActivationCategory, number>>
    ) => {
      try {
        const r = await activationApi.roster('rematricula', { limit: 1, offset: 0 });
        if (!cancelled) map.rematricula = r.total;
      } catch {
        /* fila depende de bases importadas */
      }
    };

    const load = async () => {
      try {
        const first = await reportApi.matriculadosComparison();
        if (cancelled) return;
        if (!isComparisonBuilding(first)) {
          const map: Partial<Record<ActivationCategory, number>> = {};
          for (const c of CATEGORIES) {
            map[c.id] = activationQueueCount(first.comparisons, c.comparisonId);
          }
          await overrideCaaCount(map);
          await overrideTermPhaseCounts(map);
          await overrideRematriculaCount(map);
          if (!cancelled) setIntersectionByCat(map);
          return;
        }
        for (let i = 0; i < 40 && !cancelled; i += 1) {
          await new Promise((r) => window.setTimeout(r, 3000));
          const status = await reportApi.matriculadosComparisonStatus();
          if (status.ready) {
            const data = await reportApi.matriculadosComparison();
            if (!isComparisonBuilding(data) && !cancelled) {
              const map: Partial<Record<ActivationCategory, number>> = {};
              for (const c of CATEGORIES) {
                map[c.id] = activationQueueCount(data.comparisons, c.comparisonId);
              }
              await overrideCaaCount(map);
              await overrideTermPhaseCounts(map);
              await overrideRematriculaCount(map);
              if (!cancelled) setIntersectionByCat(map);
            }
            break;
          }
        }
      } catch {
        /* totais opcionais — roster ainda funciona */
      }
    };
    void load();
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <div className="space-y-6">
      <div className="bg-white rounded-2xl border border-gray-100 shadow-sm p-4 sm:p-6">
        <h2 className="text-base font-semibold text-gray-900">Ativação por bases (matriculados)</h2>
        <p className="text-sm text-gray-500 mt-1 max-w-3xl">
          Cruza matrícula × planilhas importadas em{' '}
          <Link to="/bases" className="text-whatsapp-700 hover:underline font-medium">
            Bases
          </Link>
          , busca no DataCrazy e envia o template (1ª ativação, 5ª, etc.). Os números de referência vêm do{' '}
          <Link to="/reports" className="text-whatsapp-700 hover:underline font-medium inline-flex items-center gap-0.5">
            <BarChart3 className="w-3.5 h-3.5" />
            Relatórios
          </Link>{' '}
          (somente leitura). O cruzamento usa o <strong>Ciclo</strong> das planilhas quando existir: quem só
          coincide por RGM em ciclo antigo não entra na fila (rematrícula).
        </p>

        <div className="mt-4 flex flex-wrap gap-2">
          {CATEGORIES.map((c) => (
            <button
              key={c.id}
              type="button"
              onClick={() => setCategory(c.id)}
              className={`px-3 py-1.5 text-sm font-medium rounded-lg border transition-colors ${
                category === c.id
                  ? 'border-whatsapp-500 bg-whatsapp-50 text-whatsapp-800'
                  : 'border-gray-200 text-gray-700 hover:bg-gray-50'
              }`}
            >
              {c.label}
            </button>
          ))}
        </div>

        <ActivationTemplateMapping
          category={category}
          categoryLabel={label}
          onSaved={() => setTemplateConfigVersion((v) => v + 1)}
        />

        <div className="mt-4">
          <DatacrazyCacheSyncCard />
        </div>

        <div className="mt-4 rounded-xl border border-gray-200 bg-gray-50/60 px-4 py-3">
          <ActivationListActions
            category={category}
            label={label}
            total={intersectionTotal}
            onFilaChanged={() => setTemplateConfigVersion((v) => v + 1)}
            selectedMasterKeys={selectedMasterKeysArr}
            onClearSelection={clearSelection}
          />
        </div>
      </div>

      <ActivationRosterTable
        category={category}
        refreshToken={templateConfigVersion}
        selectedMasterKeys={selectedMasterKeys}
        onToggleSelection={toggleSelection}
        onToggleAllOnPage={toggleAllOnPage}
        onAddSelectionMany={addSelectionMany}
        onReplaceSelection={replaceSelection}
        onClearSelection={clearSelection}
      />
    </div>
  );
}
