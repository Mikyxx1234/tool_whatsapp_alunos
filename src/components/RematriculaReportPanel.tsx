import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { Download, RefreshCw } from 'lucide-react';
import {
  reportApi,
  type RematriculaReportResponse,
  type RematSubgrupoFilter,
} from '../services/reportApi';

function fmtDt(iso: string | null | undefined) {
  if (!iso) return '—';
  return new Date(iso).toLocaleString('pt-BR', {
    day: '2-digit',
    month: '2-digit',
    year: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });
}

function sourceLabel(source: string | null | undefined) {
  if (source === 'siaa') return 'SIAA';
  if (source === 'portal-de-polos') return 'Portal de Polos';
  return '—';
}

const FILTERS: { id: RematSubgrupoFilter; label: string }[] = [
  { id: 'all', label: 'Todos' },
  { id: 'adimplente', label: 'Adimplente' },
  { id: 'inadimplente', label: 'Inadimplente' },
];

interface Props {
  onRefreshOverview?: () => void;
}

export function RematriculaReportPanel({ onRefreshOverview }: Props) {
  const [subgrupo, setSubgrupo] = useState<RematSubgrupoFilter>('all');
  const [page, setPage] = useState(0);
  const [data, setData] = useState<RematriculaReportResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const limit = 200;

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const r = await reportApi.rematricula({
        subgrupo,
        limit,
        offset: page * limit,
      });
      setData(r);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Erro ao carregar rematrícula');
      setData(null);
    } finally {
      setLoading(false);
    }
  }, [subgrupo, page]);

  useEffect(() => {
    void load();
  }, [load]);

  const counts = data?.remat_subgrupo_counts ?? data?.summary;
  const adimpl = counts && 'adimplente' in counts ? counts.adimplente : data?.summary?.adimplente ?? 0;
  const inad = counts && 'inadimplente' in counts ? counts.inadimplente : data?.summary?.inadimplente ?? 0;
  const totalPages = data ? Math.max(1, Math.ceil(data.total / limit)) : 1;

  return (
    <div className="bg-white rounded-xl border border-gray-100 shadow-sm overflow-hidden space-y-0">
      <div className="px-4 py-3 border-b border-gray-100 bg-gray-50/80">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h3 className="text-sm font-semibold text-gray-900">Rematrícula (SIAA / Portal)</h3>
            <p className="text-xs text-gray-500 mt-1 max-w-3xl leading-relaxed">
              Universo: upload mais recente em{' '}
              <Link to="/bases" className="text-whatsapp-700 hover:underline font-medium">
                Bases → Rematrícula
              </Link>
              , com <strong>SIT_ATUAL = EM CURSO</strong>. Filtros: situação acadêmica e{' '}
              <strong>Adimplente</strong> / <strong>Inadimplente</strong> (coluna financeira do arquivo).
            </p>
          </div>
          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              onClick={() => {
                void load();
                onRefreshOverview?.();
              }}
              disabled={loading}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-gray-700 bg-white border border-gray-200 rounded-lg hover:bg-gray-50 disabled:opacity-50"
            >
              <RefreshCw className={`w-3.5 h-3.5 ${loading ? 'animate-spin' : ''}`} />
              Atualizar
            </button>
            <a
              href="/api/activation/rematricula/export.csv"
              className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-whatsapp-800 bg-whatsapp-50 border border-whatsapp-200 rounded-lg hover:bg-whatsapp-100"
            >
              <Download className="w-3.5 h-3.5" />
              Exportar CSV
            </a>
          </div>
        </div>

        {data?.summary?.remat_base && (
          <p className="mt-2 text-xs text-emerald-800 bg-emerald-50 border border-emerald-100 rounded-lg px-2.5 py-1.5 inline-flex flex-wrap gap-x-2">
            <span>
              Base ativa: <strong>{sourceLabel(data.summary.active_source)}</strong>
            </span>
            <span>·</span>
            <span>{data.summary.remat_base.file_name}</span>
            <span>·</span>
            <span>{(data.summary.remat_base.row_count ?? 0).toLocaleString('pt-BR')} alunos EM CURSO</span>
            <span>·</span>
            <span>{fmtDt(data.summary.remat_base.created_at)}</span>
          </p>
        )}

        {data?.summary?.warning && (
          <p className="mt-2 text-xs text-amber-800 bg-amber-50 border border-amber-100 rounded-lg px-2.5 py-1.5">
            {data.summary.warning}
          </p>
        )}

        <div className="mt-3 flex flex-wrap gap-2">
          <div className="rounded-lg border border-gray-200 bg-white px-3 py-2 min-w-[120px]">
            <p className="text-[10px] uppercase tracking-wide text-gray-500">Total fila</p>
            <p className="text-lg font-semibold tabular-nums text-gray-900">
              {(data?.summary?.total_fila ?? 0).toLocaleString('pt-BR')}
            </p>
          </div>
          <div className="rounded-lg border border-emerald-200 bg-emerald-50/50 px-3 py-2 min-w-[120px]">
            <p className="text-[10px] uppercase tracking-wide text-emerald-800">Adimplente</p>
            <p className="text-lg font-semibold tabular-nums text-emerald-900">{adimpl.toLocaleString('pt-BR')}</p>
          </div>
          <div className="rounded-lg border border-rose-200 bg-rose-50/50 px-3 py-2 min-w-[120px]">
            <p className="text-[10px] uppercase tracking-wide text-rose-800">Inadimplente</p>
            <p className="text-lg font-semibold tabular-nums text-rose-900">{inad.toLocaleString('pt-BR')}</p>
          </div>
        </div>

        <div className="mt-3 flex flex-wrap gap-1.5">
          {FILTERS.map((f) => {
            const n =
              f.id === 'all'
                ? data?.summary?.total_fila ?? 0
                : f.id === 'adimplente'
                  ? adimpl
                  : inad;
            const active = subgrupo === f.id;
            return (
              <button
                key={f.id}
                type="button"
                onClick={() => {
                  setSubgrupo(f.id);
                  setPage(0);
                }}
                className={`px-2.5 py-1 rounded-full text-xs font-medium border transition-colors ${
                  active
                    ? 'bg-whatsapp-600 text-white border-whatsapp-600'
                    : 'bg-white text-gray-700 border-gray-200 hover:border-gray-300'
                }`}
              >
                {f.label} ({n.toLocaleString('pt-BR')})
              </button>
            );
          })}
        </div>
      </div>

      {error && (
        <div className="mx-4 mt-3 rounded-lg bg-rose-50 border border-rose-200 text-xs text-rose-800 px-3 py-2">
          {error}
        </div>
      )}

      <div className="px-4 py-2 border-b border-gray-100 flex flex-wrap items-center justify-between gap-2 text-xs text-gray-500">
        <span>
          {loading
            ? 'Carregando…'
            : `Mostrando ${data?.items.length ?? 0} de ${(data?.total ?? 0).toLocaleString('pt-BR')}`}
        </span>
        {totalPages > 1 && (
          <div className="flex items-center gap-2">
            <button
              type="button"
              disabled={page <= 0 || loading}
              onClick={() => setPage((p) => Math.max(0, p - 1))}
              className="px-2 py-1 border border-gray-200 rounded disabled:opacity-40"
            >
              Anterior
            </button>
            <span>
              Página {page + 1} / {totalPages}
            </span>
            <button
              type="button"
              disabled={page >= totalPages - 1 || loading}
              onClick={() => setPage((p) => p + 1)}
              className="px-2 py-1 border border-gray-200 rounded disabled:opacity-40"
            >
              Próxima
            </button>
          </div>
        )}
      </div>

      <div className="overflow-x-auto">
        <table className="min-w-full text-sm">
          <thead className="bg-gray-50 text-gray-600">
            <tr>
              <th className="px-3 py-2 text-left font-medium">Aluno</th>
              <th className="px-3 py-2 text-left font-medium">RGM</th>
              <th className="px-3 py-2 text-left font-medium">Instituição</th>
              <th className="px-3 py-2 text-left font-medium">Polo</th>
              <th className="px-3 py-2 text-left font-medium">Curso</th>
              <th className="px-3 py-2 text-left font-medium">Situação</th>
              <th className="px-3 py-2 text-left font-medium">Financeiro</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-100">
            {!loading && (data?.items.length ?? 0) === 0 ? (
              <tr>
                <td colSpan={7} className="px-3 py-8 text-center text-gray-500">
                  Nenhum aluno neste filtro.
                </td>
              </tr>
            ) : (
              data?.items.map((row, idx) => (
                <tr key={`${row.rgm}-${idx}`} className="hover:bg-gray-50/60">
                  <td className="px-3 py-2">
                    <div className="font-medium text-gray-900">{row.nome || '—'}</div>
                    {row.email && <div className="text-xs text-gray-500">{row.email}</div>}
                  </td>
                  <td className="px-3 py-2 font-mono text-xs text-gray-700">{row.rgm || '—'}</td>
                  <td className="px-3 py-2 text-xs text-gray-700 max-w-[160px] truncate" title={row.instituicao}>
                    {row.instituicao || '—'}
                  </td>
                  <td className="px-3 py-2 text-xs text-gray-700 max-w-[120px] truncate" title={row.polo}>
                    {row.polo || '—'}
                  </td>
                  <td className="px-3 py-2 text-xs text-gray-700 max-w-[160px] truncate" title={row.curso}>
                    {row.curso || '—'}
                  </td>
                  <td className="px-3 py-2 text-xs text-gray-700">{row.situacao_matricula || '—'}</td>
                  <td className="px-3 py-2">
                    <span
                      className={`inline-flex px-1.5 py-0.5 text-[10px] font-medium rounded-full border ${
                        row.remat_subgrupo === 'inadimplente'
                          ? 'bg-rose-50 text-rose-800 border-rose-200'
                          : 'bg-emerald-50 text-emerald-800 border-emerald-200'
                      }`}
                    >
                      {row.financeiro}
                    </span>
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
