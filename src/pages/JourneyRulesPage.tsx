import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { Save, RefreshCw, Info, Trash2, PlayCircle } from 'lucide-react';
import { Header } from '../components/Header';
import { Toast, type ToastVariant } from '../components/Toast';
import {
  journeySettingsApi,
  type JourneySettingsDTO,
  type JourneySettingsPatch,
  type PreviewImpactResponse,
} from '../services/journeySettingsApi';
import { academicTermApi, type AcademicTermDTO } from '../services/academicTermApi';
import {
  maintenanceApi,
  type CleanStaleOrigemAtivacaoResponse,
  type CleanStaleActivationTagsResponse,
  type SyncCrmDesfechosResponse,
} from '../services/maintenanceApi';

interface ToastState {
  message: string;
  variant: ToastVariant;
  visible: boolean;
}

const ACAO_DELAY = [
  { id: 'avisar', label: 'Apenas avisar o aluno' },
  { id: 'ajustar', label: 'Ajustar régua automaticamente' },
  { id: 'ambos', label: 'Avisar e ajustar' },
] as const;

export default function JourneyRulesPage() {
  const [terms, setTerms] = useState<AcademicTermDTO[]>([]);
  const [scope, setScope] = useState<'GLOBAL' | string>('GLOBAL');
  const [filterNivel, setFilterNivel] = useState<string>('');
  const [filterCiclo, setFilterCiclo] = useState<string>('');
  const [settings, setSettings] = useState<JourneySettingsDTO | null>(null);
  const [draft, setDraft] = useState<JourneySettingsPatch>({});
  const [loading, setLoading] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [preview, setPreview] = useState<PreviewImpactResponse | null>(null);
  const [previewing, setPreviewing] = useState(false);

  const [toast, setToast] = useState<ToastState>({
    message: '',
    variant: 'success',
    visible: false,
  });
  const showToast = (message: string, variant: ToastVariant = 'success') =>
    setToast({ message, variant, visible: true });

  const [cleanupRunning, setCleanupRunning] = useState(false);
  const [cleanupResult, setCleanupResult] = useState<CleanStaleOrigemAtivacaoResponse | null>(null);
  const [tagCleanupRunning, setTagCleanupRunning] = useState(false);
  const [tagCleanupResult, setTagCleanupResult] = useState<CleanStaleActivationTagsResponse | null>(null);

  const [syncRunning, setSyncRunning] = useState(false);
  const [syncResult, setSyncResult] = useState<SyncCrmDesfechosResponse | null>(null);

  const runSync = useCallback(async (dryRun: boolean) => {
    setSyncRunning(true);
    try {
      const r = await maintenanceApi.syncCrmDesfechos({ dryRun });
      setSyncResult(r);
      if (r.skipped_no_config) {
        showToast('Sync ignorado: DATACRAZY_DESFECHO_CAA_FIELD_ID não configurado no .env.', 'error');
      } else {
        const verb = dryRun ? 'Simulação' : 'Sync';
        const detail = dryRun
          ? `${r.synced_revertido + r.synced_confirmado} lead(s) seriam sincronizados.`
          : `${r.synced_revertido} revertidos, ${r.synced_confirmado} confirmados, ${r.failed} falhas (de ${r.scanned} escaneados).`;
        showToast(`${verb} concluído: ${detail}`, r.failed > 0 ? 'error' : 'success');
      }
    } catch (err) {
      showToast(err instanceof Error ? err.message : 'Erro no sync', 'error');
    } finally {
      setSyncRunning(false);
    }
  }, []);

  const runCleanup = useCallback(
    async (dryRun: boolean) => {
      setCleanupRunning(true);
      try {
        const r = await maintenanceApi.cleanStaleOrigemAtivacao({ dryRun });
        setCleanupResult(r);
        const verb = dryRun ? 'Simulação' : 'Limpeza';
        const detail = dryRun
          ? `${r.scanned} lead(s) seria(m) limpos.`
          : `${r.cleaned} limpos, ${r.failed} falhas (de ${r.scanned} encontrados).`;
        showToast(`${verb} concluída: ${detail}`, r.failed > 0 ? 'error' : 'success');
      } catch (err) {
        showToast(err instanceof Error ? err.message : 'Erro no cleanup', 'error');
      } finally {
        setCleanupRunning(false);
      }
    },
    []
  );

  const runTagCleanup = useCallback(async (dryRun: boolean) => {
    setTagCleanupRunning(true);
    try {
      const r = await maintenanceApi.cleanStaleActivationTags({ dryRun });
      setTagCleanupResult(r);
      if (r.skipped_no_config) {
        showToast(
          'Limpeza de tags ignorada: NOVO_CRM_ENABLED / NOVO_CRM_API_TOKEN não configurados.',
          'error'
        );
        return;
      }
      const verb = dryRun ? 'Simulação tags' : 'Limpeza tags';
      const detail = dryRun
        ? `${r.scanned} tag(s) seria(m) removida(s).`
        : `${r.cleaned} removidas, ${r.failed} falhas (de ${r.scanned} encontradas).`;
      showToast(`${verb}: ${detail}`, r.failed > 0 ? 'error' : 'success');
    } catch (err) {
      showToast(err instanceof Error ? err.message : 'Erro no cleanup de tags', 'error');
    } finally {
      setTagCleanupRunning(false);
    }
  }, []);

  const fetchTerms = useCallback(async () => {
    try {
      const r = await academicTermApi.list({ ativoOnly: false });
      setTerms(r.terms);
    } catch (err) {
      showToast(err instanceof Error ? err.message : 'Erro ao carregar turmas', 'error');
    }
  }, []);

  const fetchSettings = useCallback(async () => {
    setLoading(true);
    try {
      const r =
        scope === 'GLOBAL'
          ? await journeySettingsApi.getGlobal()
          : await journeySettingsApi.getByTerm(scope);
      setSettings(r.settings);
      setDraft({});
    } catch (err) {
      showToast(err instanceof Error ? err.message : 'Erro', 'error');
    } finally {
      setLoading(false);
    }
  }, [scope]);

  useEffect(() => { fetchTerms(); }, [fetchTerms]);
  useEffect(() => { fetchSettings(); }, [fetchSettings]);

  // valor "efetivo" para o preview (draft + settings atuais)
  const effective = useMemo(() => {
    const base = settings || ({} as Partial<JourneySettingsDTO>);
    return {
      gap_threshold_a: draft.gap_threshold_a ?? base.gap_threshold_a ?? 2,
      gap_threshold_b: draft.gap_threshold_b ?? base.gap_threshold_b ?? 30,
      ambientacao_ativa: draft.ambientacao_ativa ?? base.ambientacao_ativa ?? false,
      ambientacao_obrigatoria:
        draft.ambientacao_obrigatoria ?? base.ambientacao_obrigatoria ?? false,
      ambientacao_dias: draft.ambientacao_dias ?? base.ambientacao_dias ?? 0,
      conteudo_previo_ativo:
        draft.conteudo_previo_ativo ?? base.conteudo_previo_ativo ?? false,
      delay_inicio_ativo: draft.delay_inicio_ativo ?? base.delay_inicio_ativo ?? false,
      delay_inicio_max_dias:
        draft.delay_inicio_max_dias ?? base.delay_inicio_max_dias ?? 0,
      delay_inicio_acao: draft.delay_inicio_acao ?? base.delay_inicio_acao ?? 'avisar',
      liberacao_acesso: draft.liberacao_acesso ?? base.liberacao_acesso ?? 'imediato',
      liberacao_acesso_dias:
        draft.liberacao_acesso_dias ?? base.liberacao_acesso_dias ?? 0,
      inativo_dias: draft.inativo_dias ?? base.inativo_dias ?? 7,
      caa_janela_t0: draft.caa_janela_t0 ?? base.caa_janela_t0 ?? 'data_chegada',
      caa_janela_dias_tipo: draft.caa_janela_dias_tipo ?? base.caa_janela_dias_tipo ?? 'corridos',
      bb_nao_acessa_dias: draft.bb_nao_acessa_dias ?? base.bb_nao_acessa_dias ?? 14,
      bb_acessou_pouco_minutos: draft.bb_acessou_pouco_minutos ?? base.bb_acessou_pouco_minutos ?? 60,
      bb_acessou_pouco_interacoes: draft.bb_acessou_pouco_interacoes ?? base.bb_acessou_pouco_interacoes ?? 10,
      origem_ativacao_stale_hours:
        draft.origem_ativacao_stale_hours ?? base.origem_ativacao_stale_hours ?? 72,
    };
  }, [draft, settings]);

  const sortedTerms = useMemo(
    () =>
      [...terms].sort(
        (a, b) =>
          Number(b.ativo) - Number(a.ativo) ||
          b.codigo.localeCompare(a.codigo)
      ),
    [terms]
  );

  const niveisDisponiveis = useMemo(() => {
    return [...new Set(terms.map((t) => t.nivel).filter(Boolean) as string[])].sort();
  }, [terms]);

  const ciclosDisponiveis = useMemo(() => {
    return [...new Set(terms.map((t) => t.ciclo).filter(Boolean) as string[])].sort().reverse();
  }, [terms]);

  const visibleTerms = useMemo(() => {
    let arr = sortedTerms;
    if (filterNivel) arr = arr.filter((t) => t.nivel === filterNivel);
    if (filterCiclo) arr = arr.filter((t) => t.ciclo === filterCiclo);
    return arr;
  }, [sortedTerms, filterNivel, filterCiclo]);

  const NIVEL_GROUPS: { id: string; label: string }[] = [
    { id: 'graduacao', label: 'Graduação' },
    { id: 'pos_graduacao', label: 'Pós-graduação' },
    { id: 'tecnico', label: 'Técnico' },
    { id: '__outros__', label: 'Sem nível definido' },
  ];

  const groupedVisibleTerms = useMemo(() => {
    const groups = new Map<string, AcademicTermDTO[]>();
    for (const t of visibleTerms) {
      const key = t.nivel || '__outros__';
      const bucket = groups.get(key) ?? [];
      bucket.push(t);
      groups.set(key, bucket);
    }
    return NIVEL_GROUPS.flatMap((g) => {
      const items = groups.get(g.id);
      if (!items || items.length === 0) return [];
      return [{ id: g.id, label: g.label, items }];
    });
  }, [visibleTerms]);

  // preview com debounce sempre que thresholds mudam
  const debounceRef = useRef<number | null>(null);
  useEffect(() => {
    if (debounceRef.current) window.clearTimeout(debounceRef.current);
    debounceRef.current = window.setTimeout(async () => {
      setPreviewing(true);
      try {
        const r = await journeySettingsApi.previewImpact({
          gap_threshold_a: effective.gap_threshold_a,
          gap_threshold_b: effective.gap_threshold_b,
          term_id: scope === 'GLOBAL' ? null : scope,
        });
        setPreview(r);
      } catch (err) {
        console.warn('[preview]', err);
      } finally {
        setPreviewing(false);
      }
    }, 350);
    return () => {
      if (debounceRef.current) window.clearTimeout(debounceRef.current);
    };
  }, [effective.gap_threshold_a, effective.gap_threshold_b, scope]);

  function handleChange<K extends keyof JourneySettingsPatch>(
    key: K,
    value: JourneySettingsPatch[K]
  ) {
    setDraft((d) => ({ ...d, [key]: value }));
  }

  async function handleSave() {
    setSubmitting(true);
    try {
      if (scope === 'GLOBAL') {
        await journeySettingsApi.putGlobal(effective);
      } else {
        await journeySettingsApi.putByTerm(scope, effective);
      }
      showToast('Regras salvas.');
      await fetchSettings();
    } catch (err) {
      showToast(err instanceof Error ? err.message : 'Erro', 'error');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="min-h-screen bg-gray-50">
      <Header showHistoryButton={false} />

      <main className="max-w-5xl mx-auto px-4 sm:px-6 lg:px-8 py-8 space-y-6">
        <div className="flex items-end justify-between flex-wrap gap-3">
          <div>
            <h2 className="text-2xl font-semibold text-gray-900">Regras da Jornada</h2>
            <p className="text-sm text-gray-500 mt-1">
              Thresholds de classificação A/B/C e comportamento da régua. Pode definir
              regras globais ou específicas por turma.
            </p>
          </div>
          <div className="flex gap-2">
            <select
              value={scope}
              onChange={(e) => setScope(e.target.value)}
              className="input"
            >
              <option value="GLOBAL">Regras globais (default)</option>
              {terms.map((t) => (
                <option key={t.id} value={t.id}>{`Turma: ${t.codigo} - ${t.nome}`}</option>
              ))}
            </select>
          </div>
        </div>

        <div className="bg-white rounded-2xl border border-gray-100 shadow-sm p-5">
          <div className="flex items-center justify-between mb-1">
            <p className="text-sm font-semibold text-gray-900">Turmas e ciclos em uso</p>
            <Link
              to="/academic-terms"
              className="text-whatsapp-700 hover:underline text-sm font-medium"
            >
              Gerenciar em Calendário →
            </Link>
          </div>
          <div className="text-xs text-gray-500 mb-4 space-y-0.5">
            <p>
              Cada aluno é vinculado a uma turma pela <code>Data Matrícula</code>. A fila{' '}
              <strong>Sem acesso BB</strong> ignora alunos cuja turma ainda não começou.
            </p>
            <p>
              Total: <strong>{terms.length}</strong> turmas cadastradas ·{' '}
              <strong>{terms.filter((t) => t.ativo).length}</strong> ativas
            </p>
          </div>
          {(niveisDisponiveis.length > 0 || ciclosDisponiveis.length > 0) && (
            <div className="flex flex-wrap items-center gap-2 mb-3">
              <span className="text-xs text-gray-500">Filtrar:</span>
              {niveisDisponiveis.length > 0 && (
                <select
                  value={filterNivel}
                  onChange={(e) => setFilterNivel(e.target.value)}
                  className="input text-xs py-1 w-auto"
                >
                  <option value="">Todos os níveis</option>
                  {niveisDisponiveis.map((n) => (
                    <option key={n} value={n}>
                      {n === 'graduacao' ? 'Graduação' : n === 'pos_graduacao' ? 'Pós-graduação' : n === 'tecnico' ? 'Técnico' : n}
                    </option>
                  ))}
                </select>
              )}
              {ciclosDisponiveis.length > 0 && (
                <select
                  value={filterCiclo}
                  onChange={(e) => setFilterCiclo(e.target.value)}
                  className="input text-xs py-1 w-auto"
                >
                  <option value="">Todos os ciclos</option>
                  {ciclosDisponiveis.map((c) => (
                    <option key={c} value={c}>{c}</option>
                  ))}
                </select>
              )}
              {(filterNivel || filterCiclo) && (
                <button
                  type="button"
                  onClick={() => { setFilterNivel(''); setFilterCiclo(''); }}
                  className="text-xs text-gray-600 hover:underline"
                >
                  Limpar
                </button>
              )}
            </div>
          )}
          {sortedTerms.length === 0 ? (
            <p className="text-sm text-gray-400 py-4 text-center">
              Nenhuma turma cadastrada. Crie em Calendário para que a regra de limbo funcione.
            </p>
          ) : visibleTerms.length === 0 ? (
            <p className="text-sm text-gray-400 py-4 text-center">
              Nenhuma turma corresponde aos filtros selecionados.
            </p>
          ) : (
            <div className="space-y-5">
              {groupedVisibleTerms.map((g) => (
                <div key={g.id}>
                  <div className="flex items-baseline gap-2 mb-2 pb-1.5 border-b border-gray-100">
                    <h4 className="text-xs font-semibold uppercase tracking-wider text-gray-600">
                      {g.label}
                    </h4>
                    <span className="text-[11px] text-gray-400 tabular-nums">
                      {g.items.length} turma{g.items.length === 1 ? '' : 's'} ·{' '}
                      {g.items.filter((t) => t.ativo).length} ativa
                      {g.items.filter((t) => t.ativo).length === 1 ? '' : 's'}
                    </span>
                  </div>
                  <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
                    {g.items.map((t) => (
                      <TermCard key={t.id} t={t} />
                    ))}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
          <div className="lg:col-span-2 space-y-6">
            <Card title="Classificação por GAP">
              <p className="text-xs text-gray-500 mb-4 flex items-start gap-1">
                <Info className="w-3.5 h-3.5 mt-0.5 shrink-0" />
                <span>
                  GAP = dias entre matrícula e início do conteúdo.
                  GAP ≤ <strong>{effective.gap_threshold_a}</strong> → Fluxo A.
                  GAP ≤ <strong>{effective.gap_threshold_b}</strong> → Fluxo B.
                  Acima → Fluxo C.
                </span>
              </p>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <NumberField
                  label="Threshold Fluxo A (≤ X dias)"
                  value={effective.gap_threshold_a}
                  onChange={(v) => handleChange('gap_threshold_a', v)}
                  min={0}
                  max={365}
                />
                <NumberField
                  label="Threshold Fluxo B (≤ Y dias)"
                  value={effective.gap_threshold_b}
                  onChange={(v) => handleChange('gap_threshold_b', v)}
                  min={effective.gap_threshold_a + 1}
                  max={365}
                />
              </div>
            </Card>

            <Card title="Ambientação">
              <ToggleRow
                label="Ambientação ativa"
                description="Existe um período de onboarding antes do início do conteúdo?"
                checked={effective.ambientacao_ativa}
                onChange={(v) => handleChange('ambientacao_ativa', v)}
              />
              {effective.ambientacao_ativa && (
                <>
                  <ToggleRow
                    label="Ambientação obrigatória"
                    description="Aluno só avança se concluir a ambientação."
                    checked={effective.ambientacao_obrigatoria}
                    onChange={(v) => handleChange('ambientacao_obrigatoria', v)}
                  />
                  <NumberField
                    label="Dias de ambientação"
                    value={effective.ambientacao_dias}
                    onChange={(v) => handleChange('ambientacao_dias', v)}
                    min={0}
                    max={90}
                  />
                </>
              )}
            </Card>

            <Card title="Conteúdo prévio">
              <ToggleRow
                label="Conteúdo prévio liberado?"
                description="Regra da régua automática (jornada). Para o Disparador manual, use o mesmo toggle na turma em Calendário."
                checked={effective.conteudo_previo_ativo}
                onChange={(v) => handleChange('conteudo_previo_ativo', v)}
              />
              <div className="rounded-lg bg-sky-50 border border-sky-200 p-3 text-xs text-sky-900 space-y-2">
                <p>
                  <strong>Disparador:</strong> marque &quot;Conteúdo prévio liberado&quot; na{' '}
                  <strong>turma</strong> (Calendário). Alunos vão para a aba{' '}
                  <strong>Conteúdo prévio</strong> — separada do Sem acesso BB. Escolha o template
                  nessa aba.
                </p>
                <p>
                  <strong>Sem prévio na turma:</strong> pré-engajamento só nos últimos{' '}
                  <strong>14 dias</strong> antes do início efetivo (aba Aguardando início).
                </p>
              </div>
            </Card>

            <Card title="Atraso no início">
              <ToggleRow
                label="Pode haver atraso no início real?"
                description="Caso a turma atrase, evita reclassificar imediatamente."
                checked={effective.delay_inicio_ativo}
                onChange={(v) => handleChange('delay_inicio_ativo', v)}
              />
              {effective.delay_inicio_ativo && (
                <>
                  <NumberField
                    label="Atraso máximo (dias)"
                    value={effective.delay_inicio_max_dias}
                    onChange={(v) => handleChange('delay_inicio_max_dias', v)}
                    min={0}
                    max={60}
                  />
                  <div>
                    <p className="text-sm font-medium text-gray-700 mb-2">Ação automática</p>
                    <div className="flex flex-col gap-1">
                      {ACAO_DELAY.map((opt) => (
                        <label
                          key={opt.id}
                          className="flex items-center gap-2 text-sm cursor-pointer"
                        >
                          <input
                            type="radio"
                            checked={effective.delay_inicio_acao === opt.id}
                            onChange={() => handleChange('delay_inicio_acao', opt.id)}
                          />
                          <span>{opt.label}</span>
                        </label>
                      ))}
                    </div>
                  </div>
                </>
              )}
            </Card>

            <Card title="Liberação de acesso & inatividade">
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <div>
                  <p className="text-sm font-medium text-gray-700 mb-1">Liberação de acesso</p>
                  <select
                    value={effective.liberacao_acesso}
                    onChange={(e) =>
                      handleChange('liberacao_acesso', e.target.value as JourneySettingsPatch['liberacao_acesso'])
                    }
                    className="input"
                  >
                    <option value="imediato">Imediato</option>
                    <option value="D+1">D+1</option>
                    <option value="D+2">D+2</option>
                    <option value="custom">Custom</option>
                  </select>
                </div>
                {effective.liberacao_acesso === 'custom' && (
                  <NumberField
                    label="Dias após matrícula (custom)"
                    value={effective.liberacao_acesso_dias}
                    onChange={(v) => handleChange('liberacao_acesso_dias', v)}
                    min={0}
                    max={60}
                  />
                )}
                <NumberField
                  label="Marcar como inativo após"
                  hint="Dias sem acesso para acionar recuperação"
                  value={effective.inativo_dias}
                  onChange={(v) => handleChange('inativo_dias', v)}
                  min={1}
                  max={120}
                />
              </div>
            </Card>

            {scope === 'GLOBAL' && (
              <Card title="Subgrupos da fila Sem acesso BB">
                <p className="text-sm text-gray-600">
                  A fila "Sem acesso BB" é dividida em 3 grupos baseados na telemetria do export.
                  Os números abaixo definem em qual grupo cada aluno é classificado.
                </p>
                <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
                  <NumberField
                    label="Dias sem acessar para classificar como 'Não acessa há tempo'"
                    hint="Quando o último acesso está há X ou mais dias"
                    value={effective.bb_nao_acessa_dias}
                    onChange={(v) => handleChange('bb_nao_acessa_dias', v)}
                    min={1}
                    max={90}
                  />
                  <NumberField
                    label="Mínimo de minutos no mês para sair da fila (acima disso = ok)"
                    hint="Aluno com menos de X minutos entra no grupo 'Acessou pouco'"
                    value={effective.bb_acessou_pouco_minutos}
                    onChange={(v) => handleChange('bb_acessou_pouco_minutos', v)}
                    min={0}
                    max={10000}
                  />
                  <NumberField
                    label="Mínimo de interações no mês para sair da fila (acima disso = ok)"
                    hint="Aluno com menos de X interações entra no grupo 'Acessou pouco'"
                    value={effective.bb_acessou_pouco_interacoes}
                    onChange={(v) => handleChange('bb_acessou_pouco_interacoes', v)}
                    min={0}
                    max={10000}
                  />
                </div>
              </Card>
            )}

            {scope === 'GLOBAL' && (
              <Card title="Janela CAA (48h)">
                <div className="rounded-lg bg-amber-50 border border-amber-200 p-3 text-xs text-amber-800">
                  Estas configurações são armazenadas, mas <strong>ainda não impactam</strong> a
                  fila CAA. A aplicação efetiva acontecerá em fase posterior.
                </div>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                  <div>
                    <p className="text-sm font-medium text-gray-700 mb-1">
                      Quando começa a contar o prazo de 48h?
                    </p>
                    <select
                      value={effective.caa_janela_t0}
                      onChange={(e) =>
                        handleChange(
                          'caa_janela_t0',
                          e.target.value as JourneySettingsPatch['caa_janela_t0']
                        )
                      }
                      className="input"
                    >
                      <option value="data_chegada">
                        Data Chegada do protocolo no CAA (default)
                      </option>
                      <option value="primeiro_export">
                        Quando o protocolo apareceu pela 1ª vez no nosso export
                      </option>
                      <option value="primeiro_envio">
                        Quando enviamos a primeira ativação
                      </option>
                    </select>
                    <p className="text-xs text-gray-500 mt-1">
                      Define o t0 da janela de acompanhamento. Afetará a expiração automática
                      de protocolos quando a feature for ativada.
                    </p>
                  </div>
                  <div>
                    <p className="text-sm font-medium text-gray-700 mb-1">
                      Os 2 dias são contados como:
                    </p>
                    <select
                      value={effective.caa_janela_dias_tipo}
                      onChange={(e) =>
                        handleChange(
                          'caa_janela_dias_tipo',
                          e.target.value as JourneySettingsPatch['caa_janela_dias_tipo']
                        )
                      }
                      className="input"
                    >
                      <option value="corridos">Dias corridos (incluindo finais de semana)</option>
                      <option value="uteis">Dias úteis (apenas segunda a sexta)</option>
                    </select>
                    <p className="text-xs text-gray-500 mt-1">
                      Dias úteis ampliam a janela efetiva em fins de semana e feriados.
                    </p>
                  </div>
                </div>
              </Card>
            )}

            {scope === 'GLOBAL' && (
              <Card title="Limpeza de origem_ativacao (CRM)">
                <div className="text-xs text-gray-600 leading-relaxed">
                  Após este intervalo desde o último disparo, o campo{' '}
                  <code className="bg-gray-100 px-1 rounded">origem_ativacao</code> do lead é
                  limpo no CRM DataCrazy (PUT value="") e respostas que chegarem além desta
                  janela <strong>são ignoradas</strong> em painéis (taxa de resposta, badges do
                  roster). A lista usa o log local{' '}
                  <code className="bg-gray-100 px-1 rounded">activation_origem_ativacao_log</code>{' '}
                  e, quando o log falhou no disparo, os envios em{' '}
                  <code className="bg-gray-100 px-1 rounded">activation_dispatch_events</code>.
                  Auditoria em{' '}
                  <code className="bg-gray-100 px-1 rounded">activation_responses</code> é
                  preservada — só não conta nas métricas.
                  <span className="block mt-2">
                    A <strong>mesma janela</strong> também limpa tags{' '}
                    <code className="bg-gray-100 px-1 rounded">ativacao-*</code> no CRM EduIT
                    (Novo CRM), via log{' '}
                    <code className="bg-gray-100 px-1 rounded">activation_novo_crm_tag_log</code>
                    — para a pessoa não ficar tagueada para sempre após ativação por tag.
                  </span>
                </div>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                  <div>
                    <p className="text-sm font-medium text-gray-700 mb-1">
                      Janela "stale" (horas)
                    </p>
                    <input
                      type="number"
                      min={1}
                      max={8760}
                      value={effective.origem_ativacao_stale_hours}
                      onChange={(e) =>
                        handleChange(
                          'origem_ativacao_stale_hours',
                          Math.max(1, Math.min(8760, Number(e.target.value) || 72))
                        )
                      }
                      className="input"
                    />
                    <p className="text-xs text-gray-500 mt-1">
                      Default 72h (3 dias). Range: 1h a 8760h (1 ano).
                    </p>
                  </div>
                  <div className="text-xs text-gray-500 self-end">
                    <p>
                      <strong>Cron interno:</strong> a app roda o cleanup automaticamente a
                      cada 24h.
                    </p>
                    <p className="mt-1">
                      <strong>Manual:</strong>{' '}
                      <code className="bg-gray-100 px-1 rounded">
                        POST /api/maintenance/clean-stale-origem-ativacao
                      </code>{' '}
                      (DataCrazy) e{' '}
                      <code className="bg-gray-100 px-1 rounded">
                        POST /api/maintenance/clean-stale-activation-tags
                      </code>{' '}
                      (Novo CRM tags).
                    </p>
                  </div>
                </div>

                <div className="border-t border-gray-100 pt-4 mt-4 space-y-3">
                  <p className="text-xs font-semibold text-gray-700 uppercase tracking-wide">
                    DataCrazy — origem_ativacao
                  </p>
                  <div className="flex flex-wrap items-center gap-2">
                    <button
                      type="button"
                      disabled={cleanupRunning}
                      onClick={() => runCleanup(true)}
                      className="inline-flex items-center gap-1.5 px-3 py-2 text-sm font-medium text-gray-700 bg-white border border-gray-300 rounded-lg hover:bg-gray-50 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
                      title="Conta quantos leads seriam limpos sem chamar o CRM"
                    >
                      <PlayCircle className="w-4 h-4" />
                      Simular (dry-run)
                    </button>
                    <button
                      type="button"
                      disabled={cleanupRunning}
                      onClick={() => {
                        if (
                          window.confirm(
                            `Limpar agora todos os leads com origem_ativacao SET há mais de ${effective.origem_ativacao_stale_hours}h?\n\nA app respeita o limite do CRM DataCrazy.`
                          )
                        ) {
                          runCleanup(false);
                        }
                      }}
                      className="inline-flex items-center gap-1.5 px-3 py-2 text-sm font-medium text-white bg-rose-600 border border-rose-600 rounded-lg hover:bg-rose-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
                      title="Chama o CRM e limpa o campo de todos os leads stale"
                    >
                      {cleanupRunning ? (
                        <RefreshCw className="w-4 h-4 animate-spin" />
                      ) : (
                        <Trash2 className="w-4 h-4" />
                      )}
                      {cleanupRunning ? 'Limpando…' : 'Limpar agora'}
                    </button>
                  </div>

                  {cleanupResult && (
                    <div
                      className={`rounded-lg border p-3 text-xs space-y-1 ${
                        cleanupResult.failed > 0
                          ? 'bg-rose-50 border-rose-200 text-rose-900'
                          : cleanupResult.dry_run
                          ? 'bg-sky-50 border-sky-200 text-sky-900'
                          : 'bg-emerald-50 border-emerald-200 text-emerald-900'
                      }`}
                    >
                      <p className="font-medium">
                        {cleanupResult.dry_run ? 'Simulação' : 'Limpeza'} —{' '}
                        {new Date(cleanupResult.ran_at).toLocaleString('pt-BR')}
                      </p>
                      <p className="tabular-nums">
                        <strong>Encontrados:</strong> {cleanupResult.scanned} ·{' '}
                        <strong>Limpos:</strong> {cleanupResult.cleaned} ·{' '}
                        <strong>Falhas:</strong> {cleanupResult.failed}
                      </p>
                      {cleanupResult.from_dispatch_only != null && (
                        <p className="opacity-75 tabular-nums">
                          Log: {cleanupResult.from_log ?? '—'} · só disparo (sem log):{' '}
                          {cleanupResult.from_dispatch_only}
                        </p>
                      )}
                      <p className="opacity-75">
                        Janela: {cleanupResult.stale_window_hours}h · Taxa CRM:{' '}
                        {cleanupResult.crm_rate_per_second}/s
                      </p>
                      {cleanupResult.errors.length > 0 && (
                        <details className="mt-2">
                          <summary className="cursor-pointer font-medium">
                            Ver {cleanupResult.errors.length} erro(s)
                          </summary>
                          <ul className="mt-1 ml-4 list-disc space-y-0.5">
                            {cleanupResult.errors.slice(0, 10).map((e, i) => (
                              <li key={i} className="font-mono">
                                <span className="opacity-60">{e.lead_id.slice(0, 8)}…</span>{' '}
                                {e.error}
                              </li>
                            ))}
                          </ul>
                        </details>
                      )}
                    </div>
                  )}
                </div>

                <div className="border-t border-gray-100 pt-4 mt-4 space-y-3">
                  <p className="text-xs font-semibold text-gray-700 uppercase tracking-wide">
                    Novo CRM — tags ativacao-*
                  </p>
                  <div className="flex flex-wrap items-center gap-2">
                    <button
                      type="button"
                      disabled={tagCleanupRunning}
                      onClick={() => runTagCleanup(true)}
                      className="inline-flex items-center gap-1.5 px-3 py-2 text-sm font-medium text-gray-700 bg-white border border-gray-300 rounded-lg hover:bg-gray-50 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
                      title="Conta quantas tags seriam removidas sem chamar o CRM"
                    >
                      <PlayCircle className="w-4 h-4" />
                      Simular tags
                    </button>
                    <button
                      type="button"
                      disabled={tagCleanupRunning}
                      onClick={() => {
                        if (
                          window.confirm(
                            `Remover agora tags ativacao-* aplicadas há mais de ${effective.origem_ativacao_stale_hours}h no Novo CRM?`
                          )
                        ) {
                          void runTagCleanup(false);
                        }
                      }}
                      className="inline-flex items-center gap-1.5 px-3 py-2 text-sm font-medium text-white bg-sky-600 border border-sky-600 rounded-lg hover:bg-sky-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
                      title="Remove tags ativacao-* stale no CRM EduIT"
                    >
                      {tagCleanupRunning ? (
                        <RefreshCw className="w-4 h-4 animate-spin" />
                      ) : (
                        <Trash2 className="w-4 h-4" />
                      )}
                      {tagCleanupRunning ? 'Limpando tags…' : 'Limpar tags agora'}
                    </button>
                  </div>

                  {tagCleanupResult && (
                    <div
                      className={`rounded-lg border p-3 text-xs space-y-1 ${
                        tagCleanupResult.failed > 0 || tagCleanupResult.skipped_no_config
                          ? 'bg-rose-50 border-rose-200 text-rose-900'
                          : tagCleanupResult.dry_run
                          ? 'bg-sky-50 border-sky-200 text-sky-900'
                          : 'bg-emerald-50 border-emerald-200 text-emerald-900'
                      }`}
                    >
                      <p className="font-medium">
                        {tagCleanupResult.skipped_no_config
                          ? 'Config ausente'
                          : tagCleanupResult.dry_run
                          ? 'Simulação tags'
                          : 'Limpeza tags'}{' '}
                        — {new Date(tagCleanupResult.ran_at).toLocaleString('pt-BR')}
                      </p>
                      <p className="tabular-nums">
                        <strong>Encontrados:</strong> {tagCleanupResult.scanned} ·{' '}
                        <strong>Limpos:</strong> {tagCleanupResult.cleaned} ·{' '}
                        <strong>Falhas:</strong> {tagCleanupResult.failed}
                      </p>
                      <p className="opacity-75">
                        Janela: {tagCleanupResult.stale_window_hours}h (mesma da origem)
                      </p>
                      {tagCleanupResult.errors.length > 0 && (
                        <details className="mt-2">
                          <summary className="cursor-pointer font-medium">
                            Ver {tagCleanupResult.errors.length} erro(s)
                          </summary>
                          <ul className="mt-1 ml-4 list-disc space-y-0.5">
                            {tagCleanupResult.errors.slice(0, 10).map((e, i) => (
                              <li key={i} className="font-mono">
                                <span className="opacity-60">
                                  {e.tag_name} / {e.contact_id.slice(0, 8)}…
                                </span>{' '}
                                {e.error}
                              </li>
                            ))}
                          </ul>
                        </details>
                      )}
                    </div>
                  )}
                </div>
              </Card>
            )}

            {scope === 'GLOBAL' && (
              <Card title="Sync de desfechos CAA do CRM">
                <div className="text-xs text-gray-600 leading-relaxed">
                  Lê o campo de desfecho CAA do lead no CRM DataCrazy (valores{' '}
                  <code className="bg-gray-100 px-1 rounded">Sim</code> /{' '}
                  <code className="bg-gray-100 px-1 rounded">Não</code>), cria ou sobrescreve o
                  desfecho em <code className="bg-gray-100 px-1 rounded">activation_manual_outcomes</code>{' '}
                  para a categoria <code className="bg-gray-100 px-1 rounded">processos-caa</code>, e
                  limpa o campo no CRM (handshake). Roda automaticamente a cada 2h.
                </div>
                <div className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800">
                  Requer <code className="bg-amber-100 px-1 rounded">DATACRAZY_DESFECHO_CAA_FIELD_ID</code>{' '}
                  configurado no <code className="bg-amber-100 px-1 rounded">.env</code>. Sem essa variável,
                  o sync é ignorado silenciosamente.
                </div>

                <div className="border-t border-gray-100 pt-4 mt-4 space-y-3">
                  <div className="flex flex-wrap items-center gap-2">
                    <button
                      type="button"
                      disabled={syncRunning}
                      onClick={() => void runSync(true)}
                      className="inline-flex items-center gap-1.5 px-3 py-2 text-sm font-medium text-gray-700 bg-white border border-gray-300 rounded-lg hover:bg-gray-50 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
                      title="Conta quantos leads seriam sincronizados sem gravar nada"
                    >
                      <PlayCircle className="w-4 h-4" />
                      Simular (dry-run)
                    </button>
                    <button
                      type="button"
                      disabled={syncRunning}
                      onClick={() => {
                        if (
                          window.confirm(
                            `Sincronizar agora todos os leads CAA dos últimos ${
                              Number(process.env.CRM_DESFECHO_SYNC_LOOKBACK_DAYS) || 14
                            } dias? Vai sobrescrever desfechos manuais existentes para esses RGMs.`
                          )
                        ) {
                          void runSync(false);
                        }
                      }}
                      className="inline-flex items-center gap-1.5 px-3 py-2 text-sm font-medium text-white bg-rose-600 border border-rose-600 rounded-lg hover:bg-rose-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
                      title="Lê o CRM e cria/sobrescreve desfechos CAA"
                    >
                      {syncRunning ? (
                        <RefreshCw className="w-4 h-4 animate-spin" />
                      ) : (
                        <Trash2 className="w-4 h-4" />
                      )}
                      {syncRunning ? 'Sincronizando…' : 'Sincronizar agora'}
                    </button>
                  </div>

                  {syncResult && (
                    <div
                      className={`rounded-lg border p-3 text-xs space-y-1 ${
                        syncResult.failed > 0
                          ? 'bg-rose-50 border-rose-200 text-rose-900'
                          : syncResult.skipped_no_config
                          ? 'bg-amber-50 border-amber-200 text-amber-900'
                          : syncResult.dry_run
                          ? 'bg-sky-50 border-sky-200 text-sky-900'
                          : 'bg-emerald-50 border-emerald-200 text-emerald-900'
                      }`}
                    >
                      <p className="font-medium">
                        {syncResult.skipped_no_config
                          ? 'Ignorado — campo não configurado'
                          : syncResult.dry_run
                          ? 'Simulação'
                          : 'Sync'}{' '}
                        — {new Date(syncResult.ran_at).toLocaleString('pt-BR')}
                      </p>
                      {!syncResult.skipped_no_config && (
                        <>
                          <p className="tabular-nums">
                            <strong>Escaneados:</strong> {syncResult.scanned} ·{' '}
                            <strong>Revertidos:</strong> {syncResult.synced_revertido} ·{' '}
                            <strong>Confirmados:</strong> {syncResult.synced_confirmado} ·{' '}
                            <strong>Ignorados:</strong> {syncResult.ignored} ·{' '}
                            <strong>Falhas:</strong> {syncResult.failed}
                          </p>
                          <p className="opacity-75">
                            Janela: {syncResult.lookback_days}d · Taxa CRM:{' '}
                            {syncResult.crm_rate_per_second}/s
                          </p>
                        </>
                      )}
                      {syncResult.errors.length > 0 && (
                        <details className="mt-2">
                          <summary className="cursor-pointer font-medium">
                            Ver {syncResult.errors.length} erro(s)
                          </summary>
                          <ul className="mt-1 ml-4 list-disc space-y-0.5">
                            {syncResult.errors.slice(0, 10).map((e, i) => (
                              <li key={i} className="font-mono">
                                <span className="opacity-60">{e.lead_id.slice(0, 8)}…</span>{' '}
                                {e.error}
                              </li>
                            ))}
                          </ul>
                        </details>
                      )}
                    </div>
                  )}
                </div>
              </Card>
            )}
          </div>

          <div className="lg:col-span-1">
            <div className="sticky top-24 space-y-4">
              <div className="bg-white rounded-2xl border border-gray-100 shadow-sm p-5">
                <div className="flex items-center justify-between mb-3">
                  <p className="text-sm font-semibold text-gray-900">Impacto estimado</p>
                  {previewing && <RefreshCw className="w-4 h-4 text-gray-400 animate-spin" />}
                </div>
                <p className="text-xs text-gray-500 mb-3">
                  Com os thresholds atuais, os alunos
                  {scope === 'GLOBAL' ? ' (todos)' : ' desta turma'} ficariam:
                </p>
                {preview ? (
                  <div className="space-y-2">
                    <FluxoBar label="Fluxo A" value={preview.fluxoCounts.A} total={preview.total_classificable} color="bg-emerald-500" />
                    <FluxoBar label="Fluxo B" value={preview.fluxoCounts.B} total={preview.total_classificable} color="bg-amber-500" />
                    <FluxoBar label="Fluxo C" value={preview.fluxoCounts.C} total={preview.total_classificable} color="bg-sky-500" />
                    <p className="text-xs text-gray-500 mt-2">
                      Total classificável: <strong>{preview.total_classificable}</strong> aluno(s)
                    </p>
                  </div>
                ) : (
                  <p className="text-xs text-gray-400">Sem dados ainda — calculando…</p>
                )}
              </div>

              <button
                onClick={handleSave}
                disabled={submitting || loading}
                className="w-full inline-flex items-center justify-center gap-2 px-4 py-3 text-sm font-medium text-white bg-whatsapp-500 rounded-lg hover:bg-whatsapp-600 disabled:opacity-50"
              >
                <Save className="w-4 h-4" />
                {submitting ? 'Salvando…' : 'Salvar regras'}
              </button>
              <p className="text-xs text-gray-500 text-center">
                Para que a mudança afete alunos já cadastrados, recalcule a régua deles
                em <em>Calendário Acadêmico</em>.
              </p>
            </div>
          </div>
        </div>
      </main>

      <Toast
        message={toast.message}
        variant={toast.variant}
        isVisible={toast.visible}
        onClose={() => setToast((t) => ({ ...t, visible: false }))}
      />
    </div>
  );
}

function Card({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="bg-white rounded-2xl border border-gray-100 shadow-sm p-5 space-y-3">
      <p className="text-sm font-semibold text-gray-900">{title}</p>
      {children}
    </div>
  );
}

function NumberField({
  label,
  hint,
  value,
  onChange,
  min,
  max,
}: {
  label: string;
  hint?: string;
  value: number;
  onChange: (v: number) => void;
  min?: number;
  max?: number;
}) {
  return (
    <label className="block">
      <span className="block text-sm font-medium text-gray-700 mb-1">{label}</span>
      <input
        type="number"
        min={min}
        max={max}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
        className="input"
      />
      {hint && <span className="block text-xs text-gray-500 mt-1">{hint}</span>}
    </label>
  );
}

function ToggleRow({
  label,
  description,
  checked,
  onChange,
}: {
  label: string;
  description?: string;
  checked: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <label className="flex items-start gap-3 cursor-pointer py-1">
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        onClick={() => onChange(!checked)}
        className={`mt-0.5 w-10 h-6 rounded-full relative transition-colors ${
          checked ? 'bg-whatsapp-500' : 'bg-gray-300'
        }`}
      >
        <span
          className={`absolute top-0.5 left-0.5 w-5 h-5 bg-white rounded-full shadow transition-transform ${
            checked ? 'translate-x-4' : 'translate-x-0'
          }`}
        />
      </button>
      <div>
        <p className="text-sm font-medium text-gray-900">{label}</p>
        {description && <p className="text-xs text-gray-500">{description}</p>}
      </div>
    </label>
  );
}

const parseTermDate = (v?: string | null): Date | null => {
  if (!v) return null;
  const raw = String(v).trim();
  if (!raw) return null;
  const withTime = raw.includes('T') ? raw : `${raw}T00:00:00Z`;
  const d = new Date(withTime);
  return Number.isNaN(d.getTime()) ? null : d;
};

const fmtBR = (iso?: string | null) => {
  const d = parseTermDate(iso);
  return d ? d.toLocaleDateString('pt-BR', { timeZone: 'UTC' }) : '—';
};

function termStatus(t: AcademicTermDTO): {
  label: string;
  cls: string;
} | null {
  if (!t.inicio_conteudo) return null;
  const hoje = Date.now();
  const inicioDate = parseTermDate(t.inicio_conteudo);
  if (!inicioDate) return null;
  const inicio = inicioDate.getTime();
  const fimDate = parseTermDate(t.fim_conteudo);
  const fim = fimDate ? fimDate.getTime() : null;

  if (hoje < inicio) {
    const dias = Math.ceil((inicio - hoje) / 86400000);
    let prefix = 'Aguardando início · ';
    if (t.tem_ambientacao && (t.dias_ambientacao ?? 0) > 0) {
      const inicioAmb = inicio - (t.dias_ambientacao ?? 0) * 86400000;
      prefix = hoje < inicioAmb ? 'Limbo · ' : 'Ambientação · ';
    }
    return {
      label: `${prefix}em ${dias}d`,
      cls: 'bg-amber-50 text-amber-700 border-amber-200',
    };
  }
  if (fim === null || hoje <= fim) {
    return { label: 'Em curso', cls: 'bg-emerald-50 text-emerald-700 border-emerald-200' };
  }
  return { label: 'Encerrada', cls: 'bg-gray-50 text-gray-600 border-gray-200' };
}

function TermCard({ t }: { t: AcademicTermDTO }) {
  const status = termStatus(t);
  return (
    <div className="border border-gray-200 rounded-xl p-3 bg-white">
      <div className="flex items-center justify-between">
        <span className="text-xs font-mono text-gray-500">{t.codigo}</span>
        {status && (
          <span
            className={`inline-flex items-center px-1.5 py-0.5 text-[10px] font-medium rounded-full border ${status.cls}`}
          >
            {status.label}
          </span>
        )}
      </div>
      <p className="text-sm font-semibold text-gray-900 mt-0.5">
        {t.nome}
        {!t.ativo && <span className="ml-1 text-xs text-gray-400">(inativa)</span>}
      </p>
      {(t.nivel || t.ciclo) && (
        <div className="flex flex-wrap gap-1 mt-1">
          {t.nivel && (
            <span className="inline-flex items-center px-1.5 py-0.5 text-[10px] font-medium rounded-full border bg-sky-50 text-sky-700 border-sky-200">
              {t.nivel === 'graduacao' ? 'Graduação' : t.nivel === 'pos_graduacao' ? 'Pós-graduação' : t.nivel === 'tecnico' ? 'Técnico' : t.nivel}
            </span>
          )}
          {t.ciclo && (
            <span className="inline-flex items-center px-1.5 py-0.5 text-[10px] font-medium rounded-full border bg-violet-50 text-violet-700 border-violet-200">
              {t.ciclo}
            </span>
          )}
        </div>
      )}
      <div className="text-xs text-gray-600 mt-2 space-y-0.5">
        <p>
          Matrícula: {fmtBR(t.inicio_matricula)} → {fmtBR(t.fim_matricula)}
        </p>
        <p>
          Conteúdo: {fmtBR(t.inicio_conteudo)} → {fmtBR(t.fim_conteudo)}
        </p>
      </div>
      {(t.total_students ?? 0) > 0 && (
        <p className="text-xs text-gray-500 mt-1">{t.total_students} aluno(s)</p>
      )}
    </div>
  );
}

function FluxoBar({
  label,
  value,
  total,
  color,
}: {
  label: string;
  value: number;
  total: number;
  color: string;
}) {
  const pct = total > 0 ? Math.round((value / total) * 100) : 0;
  return (
    <div>
      <div className="flex justify-between text-xs text-gray-700 mb-1">
        <span>{label}</span>
        <span>
          <strong>{value}</strong> · {pct}%
        </span>
      </div>
      <div className="h-2 rounded-full bg-gray-100 overflow-hidden">
        <div className={`h-full ${color}`} style={{ width: `${pct}%` }} />
      </div>
    </div>
  );
}
