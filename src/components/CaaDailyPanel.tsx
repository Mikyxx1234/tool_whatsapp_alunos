import { useCallback, useEffect, useState } from 'react';
import { AlertTriangle, ArrowUpRight, RefreshCw, ShieldCheck, Sparkles } from 'lucide-react';
import {
  reportApi,
  type CaaStatus,
  type CaaSummaryResponse,
  type CaaTransitionItem,
  type CaaFunnelCounts,
} from '../services/reportApi';

type TabId = 'novos' | 'perdidos' | 'revertidos';

const TAB_TO_STATUS: Record<TabId, CaaStatus[]> = {
  novos: ['open'],
  perdidos: ['lost_canceled', 'lost_confirmed'],
  revertidos: ['won_reverted'],
};

const STATUS_LABEL: Record<CaaStatus, string> = {
  open: 'Pendente',
  lost_canceled: 'Aluno desistiu',
  lost_confirmed: 'CAA confirmou cancelamento',
  won_reverted: 'CAA negou cancelamento',
  unknown: 'Desconhecido',
};

const STATUS_BADGE: Record<CaaStatus, string> = {
  open: 'bg-amber-50 text-amber-700 border-amber-200',
  lost_canceled: 'bg-rose-50 text-rose-700 border-rose-200',
  lost_confirmed: 'bg-rose-50 text-rose-700 border-rose-200',
  won_reverted: 'bg-emerald-50 text-emerald-700 border-emerald-200',
  unknown: 'bg-gray-50 text-gray-600 border-gray-200',
};

function fmtDateTime(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '—' : d.toLocaleString('pt-BR');
}

interface Props {
  /** Mantido apenas para chamar com janela de horas (debug). Default: último export. */
  hours?: number;
  /** Se true e hours informado, usa scope=hours em vez de last_snapshot. */
  useHoursScope?: boolean;
}

export function CaaDailyPanel({ hours, useHoursScope = false }: Props = {}) {
  const [summary, setSummary] = useState<CaaSummaryResponse | null>(null);
  const [items, setItems] = useState<CaaTransitionItem[]>([]);
  const [tab, setTab] = useState<TabId>('perdidos');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [funnelCounts, setFunnelCounts] = useState<CaaFunnelCounts | null>(null);

  const load = useCallback(
    async (currentTab: TabId) => {
      setLoading(true);
      setError(null);
      try {
        const scope = useHoursScope ? 'hours' : 'last_snapshot';
        const args = useHoursScope ? { scope, hours } : { scope } as const;
        const [s, t] = await Promise.all([
          reportApi.caaSummary(args),
          reportApi.caaTransitions({
            ...args,
            to_status: TAB_TO_STATUS[currentTab],
            current_status: currentTab === 'novos' ? 'open' : undefined,
            limit: 500,
          }),
        ]);
        setSummary(s);
        setItems(t.items);
      } catch (e) {
        setError(e instanceof Error ? e.message : 'Erro ao carregar painel CAA');
      } finally {
        setLoading(false);
      }
      // Carrega counts do funil em background (sem bloquear UI principal)
      try {
        const f = await reportApi.caaFunnel({ limit: 0, offset: 0 });
        setFunnelCounts(f.counts);
      } catch {
        // silencia — seção de estoque é secundária
      }
    },
    [hours, useHoursScope]
  );

  useEffect(() => {
    void load(tab);
  }, [load, tab]);

  return (
    <section className="bg-white rounded-xl border border-gray-100 shadow-sm">
      <header className="flex flex-wrap items-end justify-between gap-3 px-5 py-4 border-b border-gray-100">
        <div>
          <h3 className="text-base font-semibold text-gray-900">
            CAA — Painel D+1 {useHoursScope ? `(últimas ${hours ?? 24}h)` : '(último export)'}
          </h3>
          <p className="text-xs text-gray-500 mt-0.5">
            {summary?.snapshot ? (
              summary.needs_previous ? (
                <>
                  Último export: <strong>{summary.snapshot.file_name}</strong> (
                  {fmtDateTime(summary.snapshot.created_at)}). Importe um segundo export para ver o
                  D+1.
                </>
              ) : summary.identical_reimport ? (
                <>
                  Os dois últimos exports são idênticos — nenhuma mudança entre{' '}
                  {fmtDateTime(summary.snapshot.created_at)} e o import anterior.
                </>
              ) : summary.previous_snapshot ? (
                <>
                  Diff entre <strong>{summary.snapshot.file_name}</strong> (
                  {fmtDateTime(summary.snapshot.created_at)}) e o export anterior (
                  {fmtDateTime(summary.previous_snapshot.created_at)}).
                </>
              ) : (
                <>
                  Comparando <strong>{summary.snapshot.file_name}</strong> (
                  {fmtDateTime(summary.snapshot.created_at)}) com o export anterior.
                </>
              )
            ) : useHoursScope ? (
              <>Mudanças de status nas últimas {hours ?? 24}h.</>
            ) : (
              <>Nenhum upload da base CAA foi importado ainda.</>
            )}
          </p>
        </div>
        <button
          type="button"
          onClick={() => void load(tab)}
          disabled={loading}
          className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-gray-700 bg-white border border-gray-200 rounded-md hover:bg-gray-50 disabled:opacity-50"
        >
          <RefreshCw className={`w-3.5 h-3.5 ${loading ? 'animate-spin' : ''}`} />
          Atualizar
        </button>
      </header>

      {error && (
        <div className="px-5 py-3 text-sm text-rose-700 bg-rose-50 border-b border-rose-200">
          {error}
        </div>
      )}

      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3 p-5">
        <KpiCard
          icon={<Sparkles className="w-4 h-4" />}
          tone="amber"
          label="Pendentes na fila"
          value={summary?.transitions.novos_pendentes ?? 0}
          hint={
            (summary?.transitions.novos_pendentes_no_diff ?? 0) > 0
              ? `${summary!.transitions.novos_pendentes_no_diff} novo(s) neste export · restante já estava pendente`
              : 'pendentes no último export — aguardando ativação'
          }
        />
        <KpiCard
          icon={<AlertTriangle className="w-4 h-4" />}
          tone="rose"
          label="Perdemos — aluno desistiu"
          value={summary?.transitions.perdidos_canceled ?? 0}
          hint="estavam pendentes e foram canceladas pelo aluno"
        />
        <KpiCard
          icon={<ArrowUpRight className="w-4 h-4" />}
          tone="rose"
          label="Perdemos — CAA confirmou"
          value={summary?.transitions.perdidos_confirmed ?? 0}
          hint="CAA deferiu o cancelamento"
        />
        <KpiCard
          icon={<ShieldCheck className="w-4 h-4" />}
          tone="emerald"
          label="Revertidos (vitória)"
          value={summary?.transitions.revertidos ?? 0}
          hint="CAA indeferiu o cancelamento — aluno fica"
        />
      </div>

      <div className="px-5 pb-3 border-b border-gray-100">
        <div className="text-xs text-gray-500 mb-2">Estado atual da base CAA</div>
        <div className="flex flex-wrap gap-2 text-xs">
          <span className={`px-2.5 py-1 rounded-full border ${STATUS_BADGE.open}`}>
            Pendentes: <strong>{summary?.current.open ?? 0}</strong>
          </span>
          <span className={`px-2.5 py-1 rounded-full border ${STATUS_BADGE.lost_canceled}`}>
            Cancelados pelo aluno: <strong>{summary?.current.lost_canceled ?? 0}</strong>
          </span>
          <span className={`px-2.5 py-1 rounded-full border ${STATUS_BADGE.lost_confirmed}`}>
            Cancelamento confirmado: <strong>{summary?.current.lost_confirmed ?? 0}</strong>
          </span>
          <span className={`px-2.5 py-1 rounded-full border ${STATUS_BADGE.won_reverted}`}>
            Revertidos: <strong>{summary?.current.won_reverted ?? 0}</strong>
          </span>
        </div>
      </div>

      <div className="flex flex-wrap gap-1 px-5 pt-3">
        <TabButton id="perdidos" active={tab} onClick={setTab}>
          Perdidos
        </TabButton>
        <TabButton id="revertidos" active={tab} onClick={setTab}>
          Revertidos
        </TabButton>
        <TabButton id="novos" active={tab} onClick={setTab}>
          Pendentes na fila
        </TabButton>
      </div>

      {funnelCounts && <EstoqueAcumulado counts={funnelCounts} />}

      <div className="px-5 pb-5 pt-2">
        {loading ? (
          <p className="text-sm text-gray-500 py-6">Carregando…</p>
        ) : items.length === 0 ? (
          <p className="text-sm text-gray-500 py-6">
            {useHoursScope
              ? 'Nenhuma transição nesta janela. Importe uma base CAA mais recente para detectar D+1.'
              : summary?.needs_previous
                ? 'É preciso ter pelo menos dois exports CAA para calcular o D+1.'
                : summary?.snapshot
                  ? tab === 'novos'
                    ? 'Nenhum protocolo pendente no último export (após cancelamento de matrícula).'
                    : summary.identical_reimport
                      ? 'Nenhuma mudança entre os dois últimos exports. Perdidos/revertidos só aparecem quando um protocolo saiu de pendente neste diff.'
                      : 'Nenhuma mudança de status entre o último export e o anterior.'
                  : 'Nenhum upload da base CAA foi importado ainda. Faça upload em /bases para começar.'}
          </p>
        ) : (
          <div className="overflow-x-auto rounded-lg border border-gray-100">
            <table className="min-w-full text-sm">
              <thead className="bg-gray-50 text-xs text-gray-600 uppercase tracking-wider">
                <tr>
                  <th className="px-3 py-2 text-left">Aluno</th>
                  <th className="px-3 py-2 text-left">RGM</th>
                  <th className="px-3 py-2 text-left">Curso · Polo</th>
                  <th className="px-3 py-2 text-left">Transição</th>
                  <th className="px-3 py-2 text-left">Detectado em</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {items.map((it) => {
                  const displayStatus = it.current_status ?? it.to_status;
                  return (
                    <tr key={`${it.protocolo}-${it.changed_at}`} className="hover:bg-gray-50">
                      <td className="px-3 py-2 text-gray-900">{it.nome || '—'}</td>
                      <td className="px-3 py-2 text-gray-700 font-mono">{it.rgm || '—'}</td>
                      <td className="px-3 py-2 text-gray-600">
                        {[it.curso, it.polo].filter(Boolean).join(' · ') || '—'}
                      </td>
                      <td className="px-3 py-2">
                        <span className={`inline-block px-2 py-0.5 rounded-full text-[11px] border ${STATUS_BADGE[displayStatus]}`}>
                          {it.em_fila_ativacao
                            ? 'Pendente · em fila de ativação'
                            : `${it.from_status ? `${STATUS_LABEL[it.from_status]} → ` : ''}${STATUS_LABEL[displayStatus]}`}
                        </span>
                      </td>
                      <td className="px-3 py-2 text-gray-500 text-xs">{fmtDateTime(it.changed_at)}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </section>
  );
}

const ESTOQUE_CHIPS: {
  key: keyof CaaFunnelCounts;
  label: string;
  cls: string;
}[] = [
  { key: 'ativavel', label: 'Ativável', cls: 'bg-sky-50 text-sky-700 border-sky-200' },
  { key: 'perdido_silencioso', label: 'Janela vencida', cls: 'bg-amber-50 text-amber-800 border-amber-300' },
  { key: 'revertido_manual', label: 'Revert. manual', cls: 'bg-emerald-50 text-emerald-700 border-emerald-200' },
  { key: 'perdido_manual', label: 'Perdido manual', cls: 'bg-rose-50 text-rose-700 border-rose-200' },
  { key: 'revertido_export', label: 'Revert. CAA', cls: 'bg-emerald-100 text-emerald-800 border-emerald-300' },
  { key: 'perdido_export', label: 'Perdido CAA', cls: 'bg-rose-100 text-rose-800 border-rose-300' },
];

function EstoqueAcumulado({ counts }: { counts: CaaFunnelCounts }) {
  return (
    <div className="px-5 py-3 border-t border-gray-100 bg-gray-50/60">
      <div className="text-xs text-gray-500 mb-2 font-medium">
        Estoque acumulado — {counts.total_no_funil.toLocaleString('pt-BR')} protocolos no funil
      </div>
      <div className="flex flex-wrap gap-1.5">
        {ESTOQUE_CHIPS.map(({ key, label, cls }) => (
          <span
            key={key}
            className={`inline-flex items-center gap-1 px-2.5 py-1 rounded-full border text-xs ${cls}`}
          >
            <strong>{(counts[key] as number).toLocaleString('pt-BR')}</strong>
            <span className="opacity-80">{label}</span>
          </span>
        ))}
      </div>
    </div>
  );
}

function KpiCard({
  icon,
  tone,
  label,
  value,
  hint,
}: {
  icon: React.ReactNode;
  tone: 'amber' | 'rose' | 'emerald';
  label: string;
  value: number;
  hint: string;
}) {
  const map = {
    amber: 'border-amber-200 bg-amber-50 text-amber-800',
    rose: 'border-rose-200 bg-rose-50 text-rose-800',
    emerald: 'border-emerald-200 bg-emerald-50 text-emerald-800',
  } as const;
  return (
    <div className={`rounded-lg border p-3 ${map[tone]}`}>
      <div className="flex items-center gap-1.5 text-xs font-medium">
        {icon}
        {label}
      </div>
      <div className="mt-1 text-2xl font-semibold tabular-nums">{value.toLocaleString('pt-BR')}</div>
      <div className="text-[11px] opacity-80 mt-0.5">{hint}</div>
    </div>
  );
}

function TabButton({
  id,
  active,
  onClick,
  children,
}: {
  id: TabId;
  active: TabId;
  onClick: (id: TabId) => void;
  children: React.ReactNode;
}) {
  const selected = active === id;
  return (
    <button
      type="button"
      onClick={() => onClick(id)}
      className={`px-3 py-1.5 text-xs font-medium rounded-md border transition ${
        selected
          ? 'bg-whatsapp-50 border-whatsapp-300 text-whatsapp-700'
          : 'bg-white border-gray-200 text-gray-700 hover:bg-gray-50'
      }`}
    >
      {children}
    </button>
  );
}

