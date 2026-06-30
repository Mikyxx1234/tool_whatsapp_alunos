import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  RefreshCw,
  Send,
  CheckCircle,
  XCircle,
  PhoneOff,
  HelpCircle,
  TrendingUp,
  Edit3,
  AlertCircle,
  UserPlus,
  Plus,
  Trash2,
} from 'lucide-react';
import { Header } from '../components/Header';
import { OutcomeMarkerModal } from '../components/OutcomeMarkerModal';
import { AssignConsultorModal } from '../components/AssignConsultorModal';
import { CreateManualLeadModal } from '../components/CreateManualLeadModal';
import {
  CATEGORY_LABEL,
  getMeuPainelBaseLabel,
  MEU_PAINEL_CATEGORIES,
  OUTCOME_LABEL,
  OUTCOME_SHORT_LABEL,
  OUTCOME_TONE,
  fetchMeuPainelList,
  fetchMeuPainelStats,
  fetchMeuPainelOrigemStats,
  deleteManualLead,
  hasFullAccess,
  readConsultorIdentity,
  type MeuPainelCategory,
  type MeuPainelItem,
  type MeuPainelOrigemCount,
  type MeuPainelStats,
  type OutcomeKind,
} from '../services/meuPainelApi';

type RangeKey = 'today' | '7d' | '30d' | '90d' | 'all';

const RANGE_OPTIONS: Array<{ key: RangeKey; label: string; days?: number }> = [
  { key: 'today', label: 'Hoje' },
  { key: '7d', label: '7d', days: 7 },
  { key: '30d', label: '30d', days: 30 },
  { key: '90d', label: '90d', days: 90 },
  { key: 'all', label: 'Tudo' },
];

const EMPTY_STATS: MeuPainelStats = {
  total_atribuido: 0,
  total_opt_out: 0,
  total_marcado: 0,
  total_revertido: 0,
  total_confirmado: 0,
  total_sem_contato: 0,
  total_outro: 0,
  taxa_reversao: 0,
};

function fmtInt(n: number | null | undefined): string {
  return Number(n ?? 0).toLocaleString('pt-BR');
}

function fmtPct(v: number): string {
  if (!isFinite(v) || isNaN(v)) return '0%';
  return `${(v * 100).toFixed(1).replace('.', ',')}%`;
}

function fmtDateTime(iso: string | null): string {
  if (!iso) return '—';
  try {
    return new Date(iso).toLocaleString('pt-BR', {
      day: '2-digit', month: '2-digit', year: '2-digit',
      hour: '2-digit', minute: '2-digit',
    });
  } catch {
    return iso;
  }
}

function rangeToFrom(range: RangeKey): string | null {
  if (range === 'today') {
    const d = new Date();
    d.setHours(0, 0, 0, 0);
    return d.toISOString();
  }
  const opt = RANGE_OPTIONS.find((o) => o.key === range);
  if (!opt?.days) return null;
  const d = new Date();
  d.setDate(d.getDate() - opt.days);
  return d.toISOString();
}

export default function MeuPainelPage() {
  const identity = useMemo(() => readConsultorIdentity(), []);
  // "isAdmin" aqui = poder pleno (admin OU Supervisor Acadêmico). Mantém o nome
  // legado pra não trocar 20 lugares; semântica ampliada na decisão de 10/06/2026.
  const isAdmin = hasFullAccess(identity);
  // Quando tem poder pleno, permite alternar entre "Meus leads" e "Todos"
  const [adminViewAll, setAdminViewAll] = useState(isAdmin);

  const consultorParaApi = isAdmin && adminViewAll ? '*' : identity.nome || identity.username || '';
  const consultorNomeParaInsert = identity.nome || identity.username || '';

  const [range, setRange] = useState<RangeKey>('today');
  const [category, setCategory] = useState<MeuPainelCategory | ''>('processos-caa');
  const [search, setSearch] = useState('');
  const [stats, setStats] = useState<MeuPainelStats>(EMPTY_STATS);
  const [origemCounts, setOrigemCounts] = useState<MeuPainelOrigemCount[]>([]);
  const [items, setItems] = useState<MeuPainelItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [modalItem, setModalItem] = useState<MeuPainelItem | null>(null);
  const [assignItem, setAssignItem] = useState<MeuPainelItem | null>(null);
  const [createOpen, setCreateOpen] = useState(false);
  const [deletingId, setDeletingId] = useState<string | null>(null);

  // Custom date range — input state (tracks what user typed, not yet applied)
  const [customFrom, setCustomFrom] = useState('');
  const [customTo, setCustomTo] = useState('');
  // Applied state: only changes on "Aplicar" click or preset click
  const [appliedFrom, setAppliedFrom] = useState<string | null>(null);
  const [appliedTo, setAppliedTo] = useState<string | null>(null);
  const [usingCustomRange, setUsingCustomRange] = useState(false);

  const applyCustomRange = useCallback(() => {
    if (!customFrom && !customTo) return;
    setAppliedFrom(customFrom || null);
    setAppliedTo(customTo || null);
    setUsingCustomRange(true);
  }, [customFrom, customTo]);

  const selectPresetRange = useCallback((key: RangeKey) => {
    setRange(key);
    setUsingCustomRange(false);
    setAppliedFrom(null);
    setAppliedTo(null);
    setCustomFrom('');
    setCustomTo('');
  }, []);

  const reload = useCallback(async () => {
    if (!consultorParaApi) {
      setLoading(false);
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const from = usingCustomRange ? appliedFrom : rangeToFrom(range);
      const to = usingCustomRange ? appliedTo : null;
      const filters = {
        consultor: consultorParaApi,
        role: isAdmin && adminViewAll ? (identity.role || 'admin') : null,
        categoria: isAdmin && adminViewAll ? (identity.categoria || null) : null,
        category: (category || null) as MeuPainelCategory | null,
        from,
        to,
        limit: 300,
      };
      const [s, l, o] = await Promise.all([
        fetchMeuPainelStats(filters),
        fetchMeuPainelList(filters),
        fetchMeuPainelOrigemStats(filters),
      ]);
      setStats(s.stats);
      setItems(l.items);
      setOrigemCounts(o.items);
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Erro ao carregar';
      setError(msg);
    } finally {
      setLoading(false);
    }
  }, [consultorParaApi, isAdmin, adminViewAll, range, category, usingCustomRange, appliedFrom, appliedTo]);

  useEffect(() => {
    reload();
  }, [reload]);

  async function handleDeleteManual(it: MeuPainelItem) {
    if (!it.is_manual) return;
    const label = it.nome || it.rgm || 'este lead';
    if (!window.confirm(`Excluir "${label}"?\n\nSó leads criados manualmente podem ser removidos.`)) {
      return;
    }
    setDeletingId(it.response_id);
    try {
      await deleteManualLead(it.response_id);
      await reload();
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Erro ao excluir';
      window.alert(msg);
    } finally {
      setDeletingId(null);
    }
  }

  const filteredItems = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return items;
    return items.filter((it) =>
      [it.nome, it.rgm, it.cpf, it.telefone, it.protocolo, it.curso, it.polo, it.message_text]
        .filter(Boolean)
        .some((v) => String(v).toLowerCase().includes(q))
    );
  }, [items, search]);

  const origemCountsTotal = useMemo(
    () => origemCounts.reduce((sum, row) => sum + row.total, 0),
    [origemCounts]
  );

  const noIdentity = !identity.username && !identity.nome && !isAdmin;

  return (
    <div className="min-h-screen bg-gray-50">
      <Header showHistoryButton={false} />

      <main className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-5 space-y-5">
        <div className="flex items-center justify-between gap-3 flex-wrap">
          <div>
            <h1 className="text-xl sm:text-2xl font-semibold text-gray-900 flex items-center gap-2">
              <TrendingUp className="w-6 h-6 text-whatsapp-600" />
              Meu Painel
            </h1>
            <p className="text-xs sm:text-sm text-gray-500 mt-1">
              {isAdmin && adminViewAll
                ? 'Mostrando todos os leads (modo admin)'
                : `Leads atribuídos a você: ${identity.nome || identity.username || '—'}`}
            </p>
          </div>
          <div className="flex items-center gap-2">
            {category === 'processos-caa' && (
              <button
                type="button"
                onClick={() => setCreateOpen(true)}
                className="inline-flex items-center gap-2 px-3 py-2 text-xs font-semibold text-white bg-whatsapp-600 hover:bg-whatsapp-700 rounded-lg"
              >
                <Plus className="w-4 h-4" />
                Criar pessoa
              </button>
            )}
            {isAdmin && (
              <button
                type="button"
                onClick={() => setAdminViewAll((v) => !v)}
                className="px-3 py-2 text-xs font-semibold rounded-lg border border-gray-200 bg-white hover:bg-gray-50 text-gray-700"
              >
                {adminViewAll ? 'Ver apenas meus' : 'Ver todos (admin)'}
              </button>
            )}
            <button
              type="button"
              onClick={reload}
              disabled={loading}
              className="inline-flex items-center gap-2 px-3 py-2 text-xs font-semibold text-gray-700 bg-white border border-gray-200 rounded-lg hover:bg-gray-50 disabled:opacity-50"
            >
              <RefreshCw className={`w-4 h-4 ${loading ? 'animate-spin' : ''}`} />
              Atualizar
            </button>
          </div>
        </div>

        {noIdentity && (
          <div className="rounded-lg bg-amber-50 border border-amber-200 text-sm text-amber-900 px-3 py-2 flex items-start gap-2">
            <AlertCircle className="w-4 h-4 mt-0.5 shrink-0" />
            <div>
              Sua identidade de consultor não foi informada na URL. Esta página só funciona quando aberta
              de dentro do dcz-crm-sync (que injeta <code>?consultor=...&amp;consultor_nome=...</code>).
            </div>
          </div>
        )}

        {/* Filtros */}
        <div className="bg-white rounded-xl border border-gray-100 p-3 flex flex-wrap items-center gap-2 shadow-sm">
          <span className="text-xs font-semibold text-gray-500 uppercase tracking-wider">Período</span>
          <div className="inline-flex rounded-lg border border-gray-200 bg-gray-50 p-0.5">
            {RANGE_OPTIONS.map((r) => (
              <button
                key={r.key}
                type="button"
                onClick={() => selectPresetRange(r.key)}
                className={`px-3 py-1.5 text-xs font-semibold rounded-md transition-colors ${
                  !usingCustomRange && range === r.key
                    ? 'bg-white text-gray-900 shadow-sm'
                    : 'text-gray-600 hover:bg-white/60'
                }`}
              >
                {r.label}
              </button>
            ))}
          </div>

          <div className="flex items-center gap-1.5 flex-wrap">
            <span className="text-xs text-gray-500">De</span>
            <input
              type="date"
              value={customFrom}
              onChange={(e) => setCustomFrom(e.target.value)}
              className="px-2 py-1.5 text-xs border border-gray-200 rounded-lg bg-white text-gray-700 focus:outline-none focus:ring-2 focus:ring-indigo-500 accent-indigo-500"
            />
            <span className="text-xs text-gray-500">Até</span>
            <input
              type="date"
              value={customTo}
              onChange={(e) => setCustomTo(e.target.value)}
              className="px-2 py-1.5 text-xs border border-gray-200 rounded-lg bg-white text-gray-700 focus:outline-none focus:ring-2 focus:ring-indigo-500 accent-indigo-500"
            />
            <button
              type="button"
              onClick={applyCustomRange}
              className="px-3 py-1.5 text-xs font-semibold text-indigo-700 bg-indigo-50 hover:bg-indigo-100 border border-indigo-200 rounded-lg transition-colors"
            >
              Aplicar
            </button>
          </div>

          <span className="ml-2 text-xs font-semibold text-gray-500 uppercase tracking-wider">Base</span>
          <select
            value={category}
            onChange={(e) => setCategory(e.target.value as MeuPainelCategory | '')}
            className="px-3 py-1.5 text-xs border border-gray-200 rounded-lg bg-white text-gray-700 focus:outline-none focus:ring-2 focus:ring-whatsapp-500"
          >
            <option value="">Todas as bases</option>
            {MEU_PAINEL_CATEGORIES.map((c) => (
              <option key={c} value={c}>{CATEGORY_LABEL[c] || c}</option>
            ))}
          </select>

          <input
            type="search"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Buscar por nome, RGM, CPF, telefone, curso..."
            className="ml-auto flex-1 min-w-[200px] max-w-md px-3 py-1.5 text-xs border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-whatsapp-500"
          />
        </div>

        {/* KPIs */}
        <div className="grid grid-cols-2 lg:grid-cols-6 gap-3">
          <StatCard tone="sky"     Icon={Send}        label="Atribuídos"  value={fmtInt(stats.total_atribuido)} loading={loading} />
          <StatCard tone="indigo"  Icon={Edit3}       label="Marcados"    value={fmtInt(stats.total_marcado)}   hint={`${fmtPct(stats.total_marcado / Math.max(1, stats.total_atribuido))} do total`} loading={loading} />
          <StatCard tone="emerald" Icon={CheckCircle} label="Revertidos"  value={fmtInt(stats.total_revertido)} hint={`Taxa: ${fmtPct(stats.taxa_reversao)}`} loading={loading} />
          <StatCard tone="rose"    Icon={XCircle}     label="Confirmados" value={fmtInt(stats.total_confirmado)} loading={loading} />
          <StatCard tone="amber"   Icon={PhoneOff}    label="Sem contato" value={fmtInt(stats.total_sem_contato)} loading={loading} />
          <StatCard tone="gray"    Icon={HelpCircle}  label="Outro"       value={fmtInt(stats.total_outro)} loading={loading} />
        </div>

        {/* Contagem por origem_ativacao (coluna BASE) */}
        {origemCounts.length > 0 && (
          <div className="bg-white rounded-xl border border-gray-100 shadow-sm overflow-hidden">
            <div className="px-4 py-3 border-b border-gray-100 flex items-center justify-between gap-2">
              <h2 className="text-sm font-semibold text-gray-800">Por origem de ativação</h2>
              <span className="text-xs text-gray-500">{fmtInt(origemCountsTotal)} no período</span>
            </div>
            <div className="divide-y divide-gray-50">
              {origemCounts.map((row) => {
                const label = getMeuPainelBaseLabel(row.category, row.origem_ativacao || null);
                const pct = origemCountsTotal > 0 ? row.total / origemCountsTotal : 0;
                return (
                  <div key={`${row.category}:${row.origem_ativacao}`} className="px-4 py-2.5">
                    <div className="flex items-center justify-between gap-3 mb-1">
                      <span className="text-xs font-medium text-gray-700 truncate">{label}</span>
                      <span className="text-xs font-bold text-gray-900 tabular-nums shrink-0">
                        {fmtInt(row.total)}
                        <span className="ml-1.5 font-normal text-gray-500">({fmtPct(pct)})</span>
                      </span>
                    </div>
                    <div className="h-1.5 rounded-full bg-gray-100 overflow-hidden">
                      <div
                        className="h-full rounded-full bg-whatsapp-500 transition-all"
                        style={{ width: `${Math.max(pct * 100, row.total > 0 ? 2 : 0)}%` }}
                      />
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        )}

        {error && (
          <div className="rounded-lg bg-rose-50 border border-rose-200 text-sm text-rose-700 px-3 py-2 flex items-start gap-2">
            <AlertCircle className="w-4 h-4 mt-0.5 shrink-0" />
            <span>{error}</span>
          </div>
        )}

        {/* Tabela */}
        <div className="bg-white rounded-xl border border-gray-100 shadow-sm overflow-hidden">
          <div className="px-4 py-3 border-b border-gray-100 flex items-center justify-between gap-2">
            <h3 className="text-sm font-semibold text-gray-900">
              Leads para marcar
            </h3>
            <span className="text-xs text-gray-500">
              {loading ? 'Carregando…' : `${filteredItems.length} de ${items.length}`}
            </span>
          </div>

          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead className="bg-gray-50 text-gray-600">
                <tr>
                  <th className="px-3 py-2 text-left font-semibold uppercase tracking-wider">Recebido</th>
                  <th className="px-3 py-2 text-left font-semibold uppercase tracking-wider">Base</th>
                  <th className="px-3 py-2 text-left font-semibold uppercase tracking-wider">Aluno</th>
                  <th className="px-3 py-2 text-left font-semibold uppercase tracking-wider">RGM</th>
                  <th className="px-3 py-2 text-left font-semibold uppercase tracking-wider">Consultor</th>
                  <th className="px-3 py-2 text-left font-semibold uppercase tracking-wider">CAA</th>
                  <th className="px-3 py-2 text-left font-semibold uppercase tracking-wider">Marcação</th>
                  <th className="px-3 py-2 text-right font-semibold uppercase tracking-wider">Ação</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {loading && items.length === 0 ? (
                  <tr>
                    <td colSpan={8} className="px-3 py-8 text-center text-gray-500">
                      Carregando…
                    </td>
                  </tr>
                ) : filteredItems.length === 0 ? (
                  <tr>
                    <td colSpan={8} className="px-3 py-10 text-center text-gray-500">
                      {items.length === 0
                        ? 'Nenhum lead atribuído ao seu nome no período selecionado.'
                        : 'Nenhum lead corresponde aos filtros.'}
                    </td>
                  </tr>
                ) : (
                  filteredItems.map((it) => (
                    <tr key={it.response_id} className="hover:bg-gray-50/60">
                      <td className="px-3 py-2 text-gray-600 whitespace-nowrap">
                        {fmtDateTime(it.received_at)}
                      </td>
                      <td className="px-3 py-2 text-gray-700 whitespace-nowrap">
                        {getMeuPainelBaseLabel(it.category, it.origem_ativacao)}
                      </td>
                      <td className="px-3 py-2 max-w-[220px]">
                        <p className="font-medium text-gray-900 truncate" title={it.nome || ''}>
                          {it.nome || '—'}
                        </p>
                        {it.telefone && (
                          <p className="text-[11px] text-gray-500 truncate">{it.telefone}</p>
                        )}
                      </td>
                      <td className="px-3 py-2 font-mono text-gray-700 whitespace-nowrap">
                        {it.rgm || '—'}
                      </td>
                      <td className="px-3 py-2 text-gray-700 max-w-[140px] truncate" title={it.consultor_responsavel_nome || ''}>
                        {it.consultor_responsavel_nome || '—'}
                      </td>
                      <td className="px-3 py-2 whitespace-nowrap">
                        <CaaStatusPill status={it.caa_status} />
                      </td>
                      <td className="px-3 py-2 whitespace-nowrap">
                        {it.outcome ? (
                          <span className={`inline-flex items-center px-2 py-0.5 rounded-md border text-[11px] font-semibold ${OUTCOME_TONE[it.outcome as OutcomeKind]}`}>
                            {OUTCOME_SHORT_LABEL[it.outcome as OutcomeKind]}
                          </span>
                        ) : (
                          <span className="text-[11px] text-gray-400 italic">não marcado</span>
                        )}
                      </td>
                      <td className="px-3 py-2 text-right whitespace-nowrap">
                        <div className="inline-flex items-center gap-1.5 justify-end">
                          {isAdmin && (
                            <button
                              type="button"
                              onClick={() => setAssignItem(it)}
                              className="inline-flex items-center gap-1 px-2.5 py-1.5 text-[11px] font-semibold text-indigo-700 bg-indigo-50 hover:bg-indigo-100 border border-indigo-200 rounded-md"
                              title={it.consultor_responsavel_nome
                                ? `Reatribuir (atual: ${it.consultor_responsavel_nome})`
                                : 'Atribuir consultor'}
                            >
                              <UserPlus className="w-3 h-3" />
                              {it.consultor_responsavel_nome ? 'Reatribuir' : 'Atribuir'}
                            </button>
                          )}
                          <button
                            type="button"
                            onClick={() => setModalItem(it)}
                            className="inline-flex items-center gap-1 px-2.5 py-1.5 text-[11px] font-semibold text-whatsapp-700 bg-whatsapp-50 hover:bg-whatsapp-100 border border-whatsapp-200 rounded-md"
                          >
                            <Edit3 className="w-3 h-3" />
                            {it.outcome ? 'Editar' : 'Marcar'}
                          </button>
                          {it.is_manual && (
                            <button
                              type="button"
                              onClick={() => handleDeleteManual(it)}
                              disabled={deletingId === it.response_id}
                              className="inline-flex items-center gap-1 px-2.5 py-1.5 text-[11px] font-semibold text-rose-700 bg-rose-50 hover:bg-rose-100 border border-rose-200 rounded-md disabled:opacity-50"
                              title="Excluir cadastro manual"
                            >
                              <Trash2 className="w-3 h-3" />
                              Excluir
                            </button>
                          )}
                        </div>
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </div>
      </main>

      <OutcomeMarkerModal
        open={Boolean(modalItem)}
        item={modalItem}
        consultorNome={consultorNomeParaInsert}
        onClose={() => setModalItem(null)}
        onSaved={reload}
      />

      <AssignConsultorModal
        open={Boolean(assignItem)}
        item={assignItem}
        role={identity.role || ''}
        categoria={identity.categoria}
        onClose={() => setAssignItem(null)}
        onSaved={reload}
      />

      <CreateManualLeadModal
        open={createOpen}
        defaultConsultorNome={consultorNomeParaInsert}
        isAdmin={isAdmin}
        onClose={() => setCreateOpen(false)}
        onSaved={reload}
      />
    </div>
  );
}

// ──────────────────────────────────────────────────────────────────────────

interface StatCardProps {
  tone: 'sky' | 'emerald' | 'rose' | 'amber' | 'indigo' | 'gray';
  Icon: typeof Send;
  label: string;
  value: string;
  hint?: string;
  loading?: boolean;
}

function StatCard({ tone, Icon, label, value, hint, loading }: StatCardProps) {
  const toneMap: Record<StatCardProps['tone'], string> = {
    sky: 'border-sky-200 bg-sky-50 text-sky-800',
    emerald: 'border-emerald-200 bg-emerald-50 text-emerald-800',
    rose: 'border-rose-200 bg-rose-50 text-rose-800',
    amber: 'border-amber-200 bg-amber-50 text-amber-800',
    indigo: 'border-indigo-200 bg-indigo-50 text-indigo-800',
    gray: 'border-gray-200 bg-gray-50 text-gray-800',
  };
  return (
    <div className={`rounded-lg border p-3 ${toneMap[tone]}`}>
      <div className="flex items-center gap-1.5 text-xs font-medium">
        <Icon className="w-4 h-4" />
        {label}
      </div>
      <div className={`mt-1 text-2xl font-semibold tabular-nums transition-opacity ${loading ? 'opacity-40' : ''}`}>
        {value}
      </div>
      {hint && <div className="text-[11px] opacity-80 mt-0.5">{hint}</div>}
    </div>
  );
}

const CAA_STATUS_TONE: Record<string, string> = {
  open: 'bg-blue-50 text-blue-700 border-blue-200',
  won_reverted: 'bg-emerald-50 text-emerald-700 border-emerald-200',
  lost_confirmed: 'bg-rose-50 text-rose-700 border-rose-200',
  lost_canceled: 'bg-amber-50 text-amber-700 border-amber-200',
  unknown: 'bg-gray-50 text-gray-600 border-gray-200',
};

const CAA_STATUS_LABEL: Record<string, string> = {
  open: 'Aberto',
  won_reverted: 'Revertido (CAA)',
  lost_confirmed: 'Cancelado (CAA)',
  lost_canceled: 'Desistiu',
  unknown: 'Desconhecido',
};

function CaaStatusPill({ status }: { status: string | null }) {
  if (!status) return <span className="text-[11px] text-gray-400 italic">sem CAA</span>;
  const tone = CAA_STATUS_TONE[status] || CAA_STATUS_TONE.unknown;
  const label = CAA_STATUS_LABEL[status] || status;
  return (
    <span className={`inline-flex items-center px-2 py-0.5 rounded-md border text-[11px] font-semibold ${tone}`}>
      {label}
    </span>
  );
}

export { MeuPainelPage };
