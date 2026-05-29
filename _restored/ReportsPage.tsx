import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { BarChart3, RefreshCw } from 'lucide-react';
import { Header } from '../components/Header';
import { reportApi, type ReportSlug } from '../services/reportApi';
import type { StudentDTO } from '../services/studentApi';
import { academicTermApi, type AcademicTermDTO } from '../services/academicTermApi';

const REPORT_CARDS: {
  id: ReportSlug;
  title: string;
  description: string;
}[] = [
  {
    id: 'matriculados',
    title: 'Matriculados',
    description: 'Alunos com data de matrícula (status diferente de cancelado).',
  },
  {
    id: 'docs-pendentes',
    title: 'Alunos docs. pendentes',
    description:
      'Indicadores em raw_data: docs_pendentes, documentação, pendência documental ou status da documentação.',
  },
  {
    id: 'financeiro',
    title: 'Financeiro',
    description:
      'Indicadores em raw_data: situação financeira pendente, inadimplência ou status financeiro.',
  },
  {
    id: 'acessos-blackboard',
    title: 'Acessos Blackboard',
    description: 'Alunos com último acesso ao Blackboard registrado no sistema.',
  },
  {
    id: 'processos-caa',
    title: 'Processos CAA',
    description: 'Indicadores em raw_data: processo_caa, protocolo_caa, status_caa ou campo caa.',
  },
];

function fmtDate(iso: string | null | undefined): string {
  if (!iso) return '—';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '—' : d.toLocaleDateString('pt-BR');
}

function fmtDateTime(iso: string | null | undefined): string {
  if (!iso) return '—';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '—' : d.toLocaleString('pt-BR');
}

function pickRaw(s: StudentDTO, keys: string[]): string {
  const r = s.raw_data;
  if (!r || typeof r !== 'object') return '—';
  const parts: string[] = [];
  for (const k of keys) {
    const v = r[k];
    if (v === undefined || v === null) continue;
    const t = String(v).trim();
    if (!t) continue;
    parts.push(`${k}: ${t.length > 80 ? `${t.slice(0, 80)}…` : t}`);
  }
  return parts.length ? parts.join(' · ') : '—';
}

function detailColumn(slug: ReportSlug, s: StudentDTO): string {
  switch (slug) {
    case 'matriculados':
      return [fmtDate(s.data_matricula), s.tipo_matricula || ''].filter(Boolean).join(' · ') || '—';
    case 'docs-pendentes':
      return pickRaw(s, [
        'docs_pendentes',
        'documentacao',
        'pendencia_documental',
        'status_documentacao',
      ]);
    case 'financeiro':
      return pickRaw(s, [
        'situacao_financeira',
        'financeiro',
        'inadimplente',
        'status_financeiro',
      ]);
    case 'acessos-blackboard':
      return [
        fmtDateTime(s.ultimo_acesso_blackboard),
        s.minutos_acesso != null ? `${s.minutos_acesso} min` : '',
        s.total_interacoes != null ? `${s.total_interacoes} interações` : '',
      ]
        .filter(Boolean)
        .join(' · ') || '—';
    case 'processos-caa':
      return pickRaw(s, ['processo_caa', 'protocolo_caa', 'status_caa', 'caa']);
    default:
      return '—';
  }
}

export default function ReportsPage() {
  const [terms, setTerms] = useState<AcademicTermDTO[]>([]);
  const [termId, setTermId] = useState('');
  const [polo, setPolo] = useState('');
  const [active, setActive] = useState<ReportSlug>('matriculados');
  const [counts, setCounts] = useState<Partial<Record<ReportSlug, number>>>({});
  const [students, setStudents] = useState<StudentDTO[]>([]);
  const [total, setTotal] = useState(0);
  const [loadingOverview, setLoadingOverview] = useState(false);
  const [loadingList, setLoadingList] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const filters = useMemo(
    () => ({
      term_id: termId || undefined,
      polo: polo.trim() || undefined,
    }),
    [termId, polo]
  );

  const loadOverview = useCallback(async () => {
    setLoadingOverview(true);
    setError(null);
    try {
      const r = await reportApi.overview(filters);
      setCounts(r.counts);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Erro ao carregar resumo');
      setCounts({});
    } finally {
      setLoadingOverview(false);
    }
  }, [filters]);

  const loadList = useCallback(async () => {
    setLoadingList(true);
    setError(null);
    try {
      const r = await reportApi.list(active, { ...filters, limit: 200, offset: 0 });
      setStudents(r.students);
      setTotal(r.total);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Erro ao carregar lista');
      setStudents([]);
      setTotal(0);
    } finally {
      setLoadingList(false);
    }
  }, [active, filters]);

  useEffect(() => {
    academicTermApi
      .list({})
      .then((r) => setTerms(r.terms))
      .catch(() => setTerms([]));
  }, []);

  useEffect(() => {
    void loadOverview();
  }, [loadOverview]);

  useEffect(() => {
    void loadList();
  }, [loadList]);

  return (
    <div className="min-h-screen bg-gray-50">
      <Header showHistoryButton={false} />
      <main className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8 space-y-6">
        <div className="flex flex-wrap items-end justify-between gap-3">
          <div>
            <div className="flex items-center gap-2 text-gray-900">
              <BarChart3 className="w-7 h-7 text-whatsapp-600" />
              <h2 className="text-2xl font-semibold">Relatórios</h2>
            </div>
            <p className="text-sm text-gray-500 mt-1 max-w-3xl">
              Visão consolidada a partir da base de alunos. Filtros opcionais por turma e polo. Docs.,
              financeiro e CAA usam colunas extras gravadas em <code className="text-xs bg-gray-100 px-1 rounded">raw_data</code> na importação (CSV / Blackboard).
            </p>
          </div>
          <button
            type="button"
            onClick={() => {
              void loadOverview();
              void loadList();
            }}
            disabled={loadingOverview || loadingList}
            className="inline-flex items-center gap-2 px-4 py-2 text-sm font-medium text-gray-700 bg-white border border-gray-200 rounded-lg hover:bg-gray-50 disabled:opacity-50"
          >
            <RefreshCw className={`w-4 h-4 ${loadingOverview || loadingList ? 'animate-spin' : ''}`} />
            Atualizar
          </button>
        </div>

        <div className="bg-white rounded-xl border border-gray-100 p-4 flex flex-wrap gap-3 shadow-sm">
          <select
            value={termId}
            onChange={(e) => setTermId(e.target.value)}
            className="px-3 py-2 border border-gray-200 rounded-lg text-sm min-w-[200px] focus:outline-none focus:ring-2 focus:ring-whatsapp-500"
          >
            <option value="">Todas as turmas</option>
            {terms.map((t) => (
              <option key={t.id} value={t.id}>
                {t.codigo} — {t.nome}
              </option>
            ))}
          </select>
          <input
            type="text"
            placeholder="Filtrar por polo (contém)"
            value={polo}
            onChange={(e) => setPolo(e.target.value)}
            className="px-3 py-2 border border-gray-200 rounded-lg text-sm flex-1 min-w-[180px] max-w-xs focus:outline-none focus:ring-2 focus:ring-whatsapp-500"
          />
        </div>

        {error && (
          <div className="rounded-xl bg-rose-50 border border-rose-200 text-sm text-rose-700 p-3">
            {error}
          </div>
        )}

        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-5 gap-3">
          {REPORT_CARDS.map((card) => {
            const n = counts[card.id];
            const selected = active === card.id;
            return (
              <button
                key={card.id}
                type="button"
                onClick={() => setActive(card.id)}
                className={`text-left rounded-xl border p-4 transition-shadow ${
                  selected
                    ? 'border-whatsapp-400 bg-whatsapp-50 ring-2 ring-whatsapp-200 shadow-sm'
                    : 'border-gray-100 bg-white hover:border-gray-200 shadow-sm'
                }`}
              >
                <p className="text-xs font-medium text-gray-500 uppercase tracking-wide">{card.title}</p>
                <p className="text-2xl font-semibold text-gray-900 mt-1 tabular-nums">
                  {loadingOverview && n === undefined ? '…' : (n ?? 0).toLocaleString('pt-BR')}
                </p>
                <p className="text-xs text-gray-500 mt-2 leading-snug">{card.description}</p>
              </button>
            );
          })}
        </div>

        <div className="bg-white rounded-xl border border-gray-100 shadow-sm overflow-hidden">
          <div className="px-4 py-3 border-b border-gray-100 flex flex-wrap items-center justify-between gap-2">
            <h3 className="text-sm font-semibold text-gray-900">
              {REPORT_CARDS.find((c) => c.id === active)?.title ?? active}
            </h3>
            <span className="text-xs text-gray-500">
              {loadingList ? 'Carregando…' : `Mostrando ${students.length} de ${total.toLocaleString('pt-BR')}`}
            </span>
          </div>
          <div className="overflow-x-auto">
            <table className="min-w-full text-sm">
              <thead className="bg-gray-50 text-gray-600">
                <tr>
                  <th className="px-3 py-2 text-left font-medium">Aluno</th>
                  <th className="px-3 py-2 text-left font-medium">RGM</th>
                  <th className="px-3 py-2 text-left font-medium">Curso</th>
                  <th className="px-3 py-2 text-left font-medium">Polo</th>
                  <th className="px-3 py-2 text-left font-medium">Status</th>
                  <th className="px-3 py-2 text-left font-medium min-w-[220px]">Detalhe</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {students.length === 0 && !loadingList ? (
                  <tr>
                    <td colSpan={6} className="px-3 py-8 text-center text-gray-500">
                      Nenhum registro para este relatório com os filtros atuais.
                    </td>
                  </tr>
                ) : (
                  students.map((s) => (
                    <tr key={s.id} className="hover:bg-gray-50/60">
                      <td className="px-3 py-2">
                        <Link
                          to={`/students/${s.id}`}
                          className="font-medium text-whatsapp-700 hover:underline"
                        >
                          {s.nome}
                        </Link>
                        {s.email && <div className="text-xs text-gray-500">{s.email}</div>}
                      </td>
                      <td className="px-3 py-2 font-mono text-xs text-gray-700">{s.rgm || '—'}</td>
                      <td className="px-3 py-2 text-gray-700 max-w-[180px] truncate" title={s.curso || ''}>
                        {s.curso || '—'}
                      </td>
                      <td className="px-3 py-2 text-gray-700 max-w-[140px] truncate" title={s.polo || ''}>
                        {s.polo || '—'}
                      </td>
                      <td className="px-3 py-2 text-gray-700">{s.status}</td>
                      <td className="px-3 py-2 text-xs text-gray-600 whitespace-pre-wrap break-words max-w-xl">
                        {detailColumn(active, s)}
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </div>
      </main>
    </div>
  );
}
