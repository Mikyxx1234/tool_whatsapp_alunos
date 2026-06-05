import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { ChevronLeft, ChevronRight, MessageCircle } from 'lucide-react';
import { TableLoadingState } from './TableLoadingState';
import {
  activationApi,
  type ActivationCategory,
  type ActivationRosterItem,
  type ActivationStageFilter,
  type BbSubgrupo,
} from '../services/activationApi';

function fmtRelative(iso: string): string {
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return '—';
  const diffMin = Math.max(0, Math.floor((Date.now() - then) / 60000));
  if (diffMin < 1) return 'agora';
  if (diffMin < 60) return `${diffMin}min`;
  const hours = Math.floor(diffMin / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.floor(hours / 24);
  return `${days}d`;
}

function UrgencyBadge({ row }: { row: ActivationRosterItem }) {
  const u = row.bb_urgency;
  if (!u || u === 'sem_turma') return null;
  const dias = row.bb_dias_apos_inicio;
  const tone =
    u === 'alta' ? 'bg-rose-50 text-rose-700 border-rose-200' :
    u === 'media' ? 'bg-amber-50 text-amber-700 border-amber-200' :
    'bg-sky-50 text-sky-700 border-sky-200';
  const label =
    u === 'alta' ? 'Urgente' :
    u === 'media' ? 'Atrasado' :
    'Recente';
  const sufixo = typeof dias === 'number' && dias > 0 ? ` · ${dias}d` : '';
  const title =
    u === 'alta' ? `Aluno está há ${dias}d sem acessar o BB — alta urgência.` :
    u === 'media' ? `Aluno está há ${dias}d sem acessar o BB — atenção.` :
    `Aluno em fase inicial (${dias}d desde início do conteúdo).`;
  return (
    <span
      className={`inline-flex items-center px-1.5 py-0.5 text-[10px] font-medium rounded-full border ${tone}`}
      title={title}
    >
      {label}{sufixo}
    </span>
  );
}

function CaaJanelaCell({ row }: { row: ActivationRosterItem }) {
  const j = row.caa_janela;
  if (!j) {
    return <span className="text-xs text-gray-400">—</span>;
  }
  if (!j.expires_at) {
    return (
      <span
        className="inline-flex items-center px-1.5 py-0.5 text-[10px] font-medium rounded-full border bg-gray-50 text-gray-600 border-gray-200"
        title="Sem T0 disponível para calcular a janela (faltam data_chegada / first_seen_at / first_dispatch_at)."
      >
        sem janela
      </span>
    );
  }
  const expiresMs = new Date(j.expires_at).getTime();
  const diffH = (expiresMs - Date.now()) / 3_600_000;
  const t0Label =
    j.t0_source === 'data_chegada' ? 'Data Chegada CAA' :
    j.t0_source === 'primeiro_envio' ? '1º envio nosso' :
    '1º export';
  const diasLabel = j.dias_tipo === 'uteis' ? 'dias úteis' : 'horas corridas';
  const t0Iso = j.t0 ? new Date(j.t0).toLocaleString('pt-BR') : '—';
  const expiresIso = new Date(j.expires_at).toLocaleString('pt-BR');

  let label: string;
  let cls: string;
  if (diffH <= 0) {
    label = 'Vencida';
    cls = 'bg-gray-100 text-gray-600 border-gray-300';
  } else if (diffH < 1) {
    const mins = Math.max(1, Math.floor(diffH * 60));
    label = `${mins}min`;
    cls = 'bg-rose-50 text-rose-700 border-rose-200';
  } else if (diffH < 6) {
    label = `${Math.floor(diffH)}h`;
    cls = 'bg-rose-50 text-rose-700 border-rose-200';
  } else if (diffH < 12) {
    label = `${Math.floor(diffH)}h`;
    cls = 'bg-amber-50 text-amber-700 border-amber-200';
  } else {
    const h = Math.floor(diffH);
    label = h >= 48 ? `${Math.floor(h / 24)}d` : `${h}h`;
    cls = 'bg-emerald-50 text-emerald-700 border-emerald-200';
  }

  const title = `Janela 48h CAA\nBase T0: ${t0Label} (${diasLabel})\nT0: ${t0Iso}\nVence: ${expiresIso}`;
  return (
    <span
      className={`inline-flex items-center px-1.5 py-0.5 text-[10px] font-medium rounded-full border tabular-nums ${cls}`}
      title={title}
    >
      {label}
    </span>
  );
}

function ResponseBadge({ row }: { row: ActivationRosterItem }) {
  if (!row.last_response_at) return null;
  const kind = row.last_response_kind ?? 'click';
  const tone =
    kind === 'opt_out'
      ? 'bg-rose-50 text-rose-700 border-rose-200'
      : 'bg-emerald-50 text-emerald-700 border-emerald-200';
  const label =
    kind === 'opt_out'
      ? 'Opt-out'
      : kind === 'click'
        ? 'Clicou'
        : kind === 'message'
          ? 'Respondeu'
          : 'Interagiu';
  const title = row.last_response_button
    ? `${label}: ${row.last_response_button} (${fmtRelative(row.last_response_at)})`
    : `${label} há ${fmtRelative(row.last_response_at)}`;
  return (
    <span
      className={`inline-flex items-center gap-0.5 px-1.5 py-0.5 text-[10px] font-medium rounded-full border ${tone}`}
      title={title}
    >
      <MessageCircle className="w-2.5 h-2.5" />
      {label} · {fmtRelative(row.last_response_at)}
    </span>
  );
}

const PAGE_SIZE = 100;

const BB_SUBGRUPO_FILTERS: {
  id: BbSubgrupo | 'all';
  label: string;
  title: string;
}[] = [
  { id: 'all', label: 'Todos', title: 'Todos os subgrupos' },
  {
    id: 'podia_e_nao_acessou',
    label: 'Nunca acessou',
    title: 'Aluno está no export mas sem registro de acesso',
  },
  {
    id: 'nao_acessa_faz_tempo',
    label: 'Não acessa há tempo',
    title: 'Último acesso foi há muitos dias',
  },
  {
    id: 'acessou_pouco',
    label: 'Acessou pouco',
    title: 'Acessou recentemente mas com poucos minutos ou interações',
  },
];

const BB_SUBGRUPO_BADGE: Record<BbSubgrupo, { cls: string; label: string }> = {
  podia_e_nao_acessou: {
    cls: 'bg-rose-50 text-rose-700 border-rose-200',
    label: 'Nunca acessou',
  },
  nao_acessa_faz_tempo: {
    cls: 'bg-amber-50 text-amber-700 border-amber-200',
    label: 'Há tempo',
  },
  acessou_pouco: {
    cls: 'bg-sky-50 text-sky-700 border-sky-200',
    label: 'Pouco uso',
  },
};

const STAGE_FILTERS: { id: ActivationStageFilter; label: string; title: string }[] = [
  { id: 'all', label: 'Todas', title: 'Toda a fila' },
  { id: 'first', label: '1ª ativação', title: 'Nunca ativou nesta categoria' },
  { id: 'repeat', label: 'Reativação', title: '2ª a 4ª ativação (mesmo template de reativação)' },
  { id: 'fifth', label: '5ª ativação', title: 'Quinta vez ou mais nesta categoria' },
];

interface Props {
  category: ActivationCategory;
  /** Incrementar após salvar templates para atualizar a coluna Template. */
  refreshToken?: number;
  /** Set de master_keys selecionados (controlado pelo pai). */
  selectedMasterKeys?: Set<string>;
  /** Callback ao marcar/desmarcar uma linha. */
  onToggleSelection?: (masterKey: string, checked: boolean) => void;
  /** Callback ao marcar/desmarcar todos da página visível. */
  onToggleAllOnPage?: (masterKeys: string[], checked: boolean) => void;
}

export function ActivationRosterTable({
  category,
  refreshToken = 0,
  selectedMasterKeys,
  onToggleSelection,
  onToggleAllOnPage,
}: Props) {
  const [items, setItems] = useState<ActivationRosterItem[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [stageFilter, setStageFilter] = useState<ActivationStageFilter>('all');
  const [bbSubgrupo, setBbSubgrupo] = useState<BbSubgrupo | 'all'>('all');
  const [cicloFilter, setCicloFilter] = useState('');
  const [availableCiclos, setAvailableCiclos] = useState<string[]>([]);
  const [totalUnfiltered, setTotalUnfiltered] = useState<number | null>(null);
  const [slowLoad, setSlowLoad] = useState(false);
  const [skippedLimbo, setSkippedLimbo] = useState(0);
  const [urgencyCounts, setUrgencyCounts] = useState<{ alta: number; media: number; normal: number; sem_turma: number } | null>(null);
  const [subgrupoCounts, setSubgrupoCounts] = useState<{ podia_e_nao_acessou: number; nao_acessa_faz_tempo: number; acessou_pouco: number } | null>(null);

  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const safePage = Math.min(page, totalPages - 1);
  const rangeStart = total === 0 ? 0 : safePage * PAGE_SIZE + 1;
  const rangeEnd = Math.min((safePage + 1) * PAGE_SIZE, total);

  const load = useCallback(
    async (pageIndex: number) => {
      setLoading(true);
      setError(null);
      const slowTimer = window.setTimeout(() => setSlowLoad(true), 8000);
      try {
        const r = await activationApi.roster(category, {
          limit: PAGE_SIZE,
          offset: pageIndex * PAGE_SIZE,
          activationStage: stageFilter,
          bbSubgrupo: category === 'acessos-blackboard' ? bbSubgrupo : undefined,
          ciclo: cicloFilter || undefined,
        });
        setItems(r.items);
        setTotal(r.total);
        setTotalUnfiltered(r.total_unfiltered ?? r.total);
        setSkippedLimbo(r.skipped_bb_limbo ?? 0);
        setUrgencyCounts(r.bb_urgency_counts ?? null);
        setSubgrupoCounts(r.bb_subgrupo_counts ?? null);
        setAvailableCiclos(r.available_ciclos ?? []);
      } catch (e) {
        setError(e instanceof Error ? e.message : 'Erro ao carregar fila');
        setItems([]);
        setTotal(0);
      } finally {
        window.clearTimeout(slowTimer);
        setSlowLoad(false);
        setLoading(false);
      }
    },
    [category, stageFilter, bbSubgrupo, cicloFilter]
  );

  useEffect(() => {
    setPage(0);
  }, [category, stageFilter, bbSubgrupo, cicloFilter]);

  useEffect(() => {
    void load(page);
  }, [load, page, refreshToken]);

  const goToPage = (next: number) => {
    const clamped = Math.max(0, Math.min(next, totalPages - 1));
    setPage(clamped);
  };

  return (
    <div className="bg-white rounded-xl border border-gray-100 shadow-sm overflow-hidden">
      <div className="px-4 py-3 border-b border-gray-100 space-y-2">
        <div className="flex flex-wrap items-center gap-1.5">
          <span className="text-[11px] font-medium text-gray-600 mr-1">Próxima mensagem:</span>
          {STAGE_FILTERS.map((f) => (
            <button
              key={f.id}
              type="button"
              title={f.title}
              onClick={() => setStageFilter(f.id)}
              className={`px-2.5 py-1 text-[11px] font-medium rounded-lg border transition-colors ${
                stageFilter === f.id
                  ? 'border-whatsapp-500 bg-whatsapp-50 text-whatsapp-800'
                  : 'border-gray-200 text-gray-600 hover:bg-gray-50'
              }`}
            >
              {f.label}
            </button>
          ))}
        </div>
        <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-gray-500">
          <span>
            {loading ? (
              slowLoad ? (
                <>Montando fila no servidor… 1ª vez pode levar ~1 min (depois fica rápido)</>
              ) : (
                'Carregando…'
              )
            ) : total === 0 ? (
              stageFilter === 'all' ? (
                'Nenhum registro na fila'
              ) : (
                <>Nenhum aluno neste filtro de ativação</>
              )
            ) : (
              <>
                Mostrando {rangeStart.toLocaleString('pt-BR')}–{rangeEnd.toLocaleString('pt-BR')} de{' '}
                {total.toLocaleString('pt-BR')}
                {stageFilter !== 'all' && totalUnfiltered != null && totalUnfiltered !== total && (
                  <> (de {totalUnfiltered.toLocaleString('pt-BR')} na fila)</>
                )}
              </>
            )}
          </span>
          <button type="button" onClick={() => void load(page)} className="text-whatsapp-700 hover:underline">
            Atualizar fila
          </button>
        </div>
      </div>

      {error && (
        <div className="mx-4 mt-3 text-xs text-rose-700 bg-rose-50 border border-rose-100 rounded-lg px-3 py-2">
          {error}
        </div>
      )}

      {category === 'acessos-blackboard' && subgrupoCounts && (
        <div className="px-4 pt-2 pb-1">
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="text-[11px] font-medium text-gray-600 mr-1">Subgrupo BB:</span>
            {BB_SUBGRUPO_FILTERS.map((f) => {
              const count =
                f.id === 'all'
                  ? (subgrupoCounts.podia_e_nao_acessou +
                    subgrupoCounts.nao_acessa_faz_tempo +
                    subgrupoCounts.acessou_pouco)
                  : subgrupoCounts[f.id];
              return (
                <button
                  key={f.id}
                  type="button"
                  title={f.title}
                  onClick={() => { setBbSubgrupo(f.id); setPage(0); }}
                  className={`px-2.5 py-1 text-[11px] font-medium rounded-lg border transition-colors ${
                    bbSubgrupo === f.id
                      ? 'border-whatsapp-500 bg-whatsapp-50 text-whatsapp-800'
                      : 'border-gray-200 text-gray-600 hover:bg-gray-50'
                  }`}
                >
                  {f.label}
                  {count != null && (
                    <span className="ml-1 tabular-nums opacity-75">({count})</span>
                  )}
                </button>
              );
            })}
          </div>
        </div>
      )}
      {availableCiclos.length > 1 && (
        <div className="px-4 pt-2 pb-1">
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="text-[11px] font-medium text-gray-600 mr-1">Ciclo:</span>
            <button
              type="button"
              onClick={() => { setCicloFilter(''); setPage(0); }}
              className={`px-2.5 py-1 text-[11px] font-medium rounded-lg border transition-colors ${
                cicloFilter === ''
                  ? 'border-whatsapp-500 bg-whatsapp-50 text-whatsapp-800'
                  : 'border-gray-200 text-gray-600 hover:bg-gray-50'
              }`}
            >
              Todos
            </button>
            {availableCiclos.map((c) => (
              <button
                key={c}
                type="button"
                onClick={() => { setCicloFilter(c); setPage(0); }}
                className={`px-2.5 py-1 text-[11px] font-medium rounded-lg border transition-colors ${
                  cicloFilter === c
                    ? 'border-whatsapp-500 bg-whatsapp-50 text-whatsapp-800'
                    : 'border-gray-200 text-gray-600 hover:bg-gray-50'
                }`}
              >
                {c}
              </button>
            ))}
          </div>
        </div>
      )}
      {category === 'acessos-blackboard' && skippedLimbo > 0 && (
        <div className="mx-4 mt-3 text-xs text-amber-800 bg-amber-50 border border-amber-200 rounded-lg px-3 py-2">
          <strong>{skippedLimbo.toLocaleString('pt-BR')}</strong> aluno(s) cuja turma ainda não
          começou estão na aba{' '}
          <Link to="/?mode=activation" className="underline font-medium">
            Aguardando início
          </Link>
          .
        </div>
      )}
      {category === 'acessos-blackboard' && urgencyCounts && (urgencyCounts.alta + urgencyCounts.media > 0) && (
        <div className="mx-4 mt-2 flex flex-wrap items-center gap-2 text-xs">
          <span className="text-gray-500">Urgência:</span>
          <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full border bg-rose-50 text-rose-700 border-rose-200">
            <strong>{urgencyCounts.alta}</strong> urgentes
          </span>
          <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full border bg-amber-50 text-amber-700 border-amber-200">
            <strong>{urgencyCounts.media}</strong> atrasados
          </span>
          <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full border bg-sky-50 text-sky-700 border-sky-200">
            <strong>{urgencyCounts.normal}</strong> recentes
          </span>
          {urgencyCounts.sem_turma > 0 && (
            <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full border bg-gray-50 text-gray-600 border-gray-200">
              <strong>{urgencyCounts.sem_turma}</strong> sem turma
            </span>
          )}
        </div>
      )}

      <div className="overflow-x-auto">
        <table className="min-w-full text-sm">
          <thead className="bg-gray-50 text-gray-600">
            <tr>
              {selectedMasterKeys && (
                <th className="px-3 py-2 text-center font-medium w-8">
                  <input
                    type="checkbox"
                    className="cursor-pointer accent-whatsapp-600"
                    aria-label="Selecionar todos da página"
                    checked={
                      items.length > 0 &&
                      items.every((it) => it.master_key && selectedMasterKeys.has(it.master_key))
                    }
                    ref={(el) => {
                      if (!el) return;
                      const someSelected = items.some(
                        (it) => it.master_key && selectedMasterKeys.has(it.master_key)
                      );
                      const allSelected =
                        items.length > 0 &&
                        items.every((it) => it.master_key && selectedMasterKeys.has(it.master_key));
                      el.indeterminate = someSelected && !allSelected;
                    }}
                    onChange={(e) => {
                      const pageKeys = items
                        .map((it) => it.master_key)
                        .filter((k): k is string => typeof k === 'string' && k.length > 0);
                      onToggleAllOnPage?.(pageKeys, e.target.checked);
                    }}
                  />
                </th>
              )}
              <th className="px-3 py-2 text-left font-medium">Aluno</th>
              <th className="px-3 py-2 text-left font-medium">RGM</th>
              <th className="px-3 py-2 text-left font-medium">Ciclo</th>
              <th className="px-3 py-2 text-left font-medium">Polo</th>
              {category === 'acessos-blackboard' && <th className="px-3 py-2 text-left font-medium">Grupo</th>}
              {category === 'aguardando-inicio' && <th className="px-3 py-2 text-left font-medium">Início em</th>}
              {category === 'processos-caa' && (
                <th className="px-3 py-2 text-left font-medium" title="Tempo restante na janela 48h CAA">
                  Janela
                </th>
              )}
              <th className="px-3 py-2 text-left font-medium">Vezes ativado</th>
              <th className="px-3 py-2 text-left font-medium">Próxima msg</th>
              <th className="px-3 py-2 text-left font-medium">Template</th>
              {category === 'processos-caa' && <th className="px-3 py-2 text-left font-medium">Ações</th>}
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-100">
            {loading ? (
              <TableLoadingState
                colSpan={
                  (category === 'processos-caa' ? 9
                    : category === 'acessos-blackboard' || category === 'aguardando-inicio' ? 8
                    : 7) + (selectedMasterKeys ? 1 : 0)
                }
                slow={slowLoad}
                variant={slowLoad ? 'big' : 'normal'}
              />
            ) : items.length === 0 ? (
              <tr>
                <td
                  colSpan={
                    (category === 'processos-caa' ? 9
                      : category === 'acessos-blackboard' || category === 'aguardando-inicio' ? 8
                      : 7) + (selectedMasterKeys ? 1 : 0)
                  }
                  className="px-3 py-6 text-center text-gray-500 text-xs"
                >
                  Nenhum matriculado nesta fila. Importe as planilhas em Bases e confira Relatórios.
                </td>
              </tr>
            ) : (
              items.map((row, i) => (
                <tr key={`${row.rgm}-${safePage}-${i}`} className="hover:bg-gray-50/60">
                  {selectedMasterKeys && (
                    <td className="px-3 py-2 text-center w-8">
                      <input
                        type="checkbox"
                        className="cursor-pointer accent-whatsapp-600 disabled:opacity-40"
                        disabled={!row.master_key}
                        aria-label={`Selecionar ${row.nome ?? row.rgm ?? 'aluno'}`}
                        checked={Boolean(row.master_key && selectedMasterKeys.has(row.master_key))}
                        onChange={(e) => {
                          if (row.master_key) onToggleSelection?.(row.master_key, e.target.checked);
                        }}
                      />
                    </td>
                  )}
                  <td className="px-3 py-2">
                    <div className="flex items-center gap-1.5">
                      <span className="font-medium text-gray-900">{row.nome || '—'}</span>
                      {category === 'acessos-blackboard' && <UrgencyBadge row={row} />}
                      {row.last_response_at && <ResponseBadge row={row} />}
                    </div>
                    {row.email && <div className="text-xs text-gray-500">{row.email}</div>}
                  </td>
                  <td className="px-3 py-2 font-mono text-xs">{row.rgm || '—'}</td>
                  <td className="px-3 py-2 text-xs text-gray-600">{row.ciclo || '—'}</td>
                  <td className="px-3 py-2 text-xs text-gray-600 max-w-[120px] truncate" title={row.polo}>
                    {row.polo || '—'}
                  </td>
                  {category === 'acessos-blackboard' && (
                    <td className="px-3 py-2">
                      {row.bb_subgrupo && BB_SUBGRUPO_BADGE[row.bb_subgrupo] ? (
                        <span
                          className={`inline-flex items-center px-1.5 py-0.5 text-[10px] font-medium rounded-full border ${BB_SUBGRUPO_BADGE[row.bb_subgrupo].cls}`}
                        >
                          {BB_SUBGRUPO_BADGE[row.bb_subgrupo].label}
                        </span>
                      ) : '—'}
                    </td>
                  )}
                  {category === 'aguardando-inicio' && (
                    <td className="px-3 py-2 text-xs tabular-nums text-amber-700 font-medium">
                      {row.dias_ate_inicio != null ? `${row.dias_ate_inicio}d` : '—'}
                    </td>
                  )}
                  {category === 'processos-caa' && (
                    <td className="px-3 py-2">
                      <CaaJanelaCell row={row} />
                    </td>
                  )}
                  <td className="px-3 py-2 tabular-nums font-semibold text-gray-900">
                    {row.prior_activation_count}
                  </td>
                  <td className="px-3 py-2 text-xs">
                    <span
                      className={
                        row.message_tier === 'first'
                          ? 'text-emerald-700'
                          : row.message_tier === 'fifth'
                            ? 'text-amber-800'
                            : 'text-gray-600'
                      }
                    >
                      {row.message_tier_label}
                    </span>
                  </td>
                  <td
                    className="px-3 py-2 text-xs font-mono text-gray-600 max-w-[140px] truncate"
                    title={row.template_name ?? ''}
                  >
                    {row.template_configured ? (
                      row.template_name
                    ) : (
                      <span className="text-rose-600">selecione acima</span>
                    )}
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>

      {total > PAGE_SIZE && (
        <div className="px-4 py-3 border-t border-gray-100 flex flex-wrap items-center justify-between gap-2 bg-gray-50/50">
          <span className="text-xs text-gray-600">
            Página {safePage + 1} de {totalPages.toLocaleString('pt-BR')} · {PAGE_SIZE} por página
          </span>
          <div className="flex items-center gap-1">
            <button
              type="button"
              disabled={loading || safePage <= 0}
              onClick={() => goToPage(safePage - 1)}
              className="inline-flex items-center gap-1 px-2.5 py-1.5 text-xs font-medium text-gray-700 bg-white border border-gray-200 rounded-lg hover:bg-gray-50 disabled:opacity-40"
            >
              <ChevronLeft className="w-3.5 h-3.5" />
              Anterior
            </button>
            <button
              type="button"
              disabled={loading || safePage >= totalPages - 1}
              onClick={() => goToPage(safePage + 1)}
              className="inline-flex items-center gap-1 px-2.5 py-1.5 text-xs font-medium text-gray-700 bg-white border border-gray-200 rounded-lg hover:bg-gray-50 disabled:opacity-40"
            >
              Próxima
              <ChevronRight className="w-3.5 h-3.5" />
            </button>
          </div>
        </div>
      )}

    </div>
  );
}
