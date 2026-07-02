import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link, Navigate } from 'react-router-dom';
import { Plus, RefreshCw, Target, Trash2 } from 'lucide-react';
import { Header } from '../components/Header';
import {
  consultorMetasApi,
  type ConsultorMetaCatalogoRow,
  type ConsultorMetaRow,
} from '../services/consultorMetasApi';
import {
  firstAllowedRoute,
  getConsultoresCatalogo,
  hasFullAccess,
  isAbaPermitida,
  readConsultorIdentity,
} from '../services/meuPainelApi';

function currentAnoMes(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

export default function MetasPage() {
  const identity = readConsultorIdentity();
  const canAccess = hasFullAccess(identity) && isAbaPermitida('metas');

  const [anoMes, setAnoMes] = useState(currentAnoMes);
  const [rows, setRows] = useState<ConsultorMetaRow[]>([]);
  const [catalogo, setCatalogo] = useState<ConsultorMetaCatalogoRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [mostrarComMeta, setMostrarComMeta] = useState(false);

  const [consultorKey, setConsultorKey] = useState('');
  const [meta, setMeta] = useState('');

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const crmCatalog = getConsultoresCatalogo();
      const [items, consultores] = await Promise.all([
        consultorMetasApi.list(anoMes),
        consultorMetasApi.listConsultores(anoMes, crmCatalog),
      ]);
      setRows(items);
      setCatalogo(consultores);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Erro ao carregar');
    } finally {
      setLoading(false);
    }
  }, [anoMes]);

  useEffect(() => {
    if (canAccess) void load();
  }, [canAccess, load]);

  const opcoesConsultor = useMemo(() => {
    return catalogo.filter((c) => mostrarComMeta || !c.tem_meta);
  }, [catalogo, mostrarComMeta]);

  const selectedConsultor = useMemo(
    () => catalogo.find((c) => c.nome.toLowerCase() === consultorKey.toLowerCase()) ?? null,
    [catalogo, consultorKey]
  );

  if (!hasFullAccess(identity)) {
    return <Navigate to={firstAllowedRoute()} replace />;
  }
  if (!isAbaPermitida('metas')) {
    return <Navigate to={firstAllowedRoute()} replace />;
  }

  async function handleSave(e: React.FormEvent) {
    e.preventDefault();
    const consultor_nome = selectedConsultor?.nome || consultorKey.trim();
    const meta_marcados = Math.max(0, parseInt(meta, 10) || 0);
    if (!consultor_nome) return;
    setSaving(true);
    setError(null);
    try {
      await consultorMetasApi.upsert({ consultor_nome, ano_mes: anoMes, meta_marcados });
      setConsultorKey('');
      setMeta('');
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Erro ao salvar');
    } finally {
      setSaving(false);
    }
  }

  async function handleDelete(id: string) {
    if (!window.confirm('Remover esta meta?')) return;
    try {
      await consultorMetasApi.remove(id);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Erro ao remover');
    }
  }

  const semCatalogoCrm = !loading && catalogo.every((c) => c.origem !== 'crm');

  return (
    <div className="min-h-screen bg-gray-50">
      <Header showHistoryButton={false} />
      <main className="max-w-4xl mx-auto px-4 sm:px-6 lg:px-8 py-6 space-y-6">
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
          <div>
            <Link to="/painel" className="text-xs text-indigo-600 hover:underline">
              ← Painel Geral
            </Link>
            <h2 className="font-display text-xl font-extrabold tracking-tight text-gray-900 mt-1 flex items-center gap-2">
              <Target className="w-5 h-5 text-indigo-600" />
              Metas por consultor
            </h2>
            <p className="text-sm text-gray-500">
              Meta diária de atendimentos marcados — vigência por mês
            </p>
          </div>
          <div className="flex items-center gap-2">
            <label className="text-xs text-gray-500">Mês de vigência</label>
            <input
              type="month"
              value={anoMes}
              onChange={(e) => setAnoMes(e.target.value)}
              className="text-sm border border-gray-200 rounded-lg px-2 py-1.5"
            />
            <button
              type="button"
              onClick={() => void load()}
              className="p-2 text-gray-600 border border-gray-200 rounded-lg hover:bg-white"
            >
              <RefreshCw className={`w-4 h-4 ${loading ? 'animate-spin' : ''}`} />
            </button>
          </div>
        </div>

        {semCatalogoCrm && (
          <div className="p-3 rounded-lg bg-amber-50 border border-amber-200 text-amber-900 text-xs">
            Lista de consultores do CRM não carregada. Abra pelo dcz (admin/supervisor) ou
            configure <code className="font-mono">DCZ_CONSULTORES_URL</code> no servidor do tool.
          </div>
        )}

        {error && (
          <div className="p-4 rounded-lg bg-rose-50 border border-rose-200 text-rose-700 text-sm">
            {error}
          </div>
        )}

        <form
          onSubmit={(e) => void handleSave(e)}
          className="rounded-xl border border-gray-100 bg-white p-4 shadow-sm space-y-3"
        >
          <h3 className="text-sm font-semibold text-gray-900 flex items-center gap-2">
            <Plus className="w-4 h-4" />
            Cadastrar meta
          </h3>
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
            <div className="sm:col-span-2 space-y-2">
              <div className="flex items-center justify-between gap-2">
                <label className="block text-xs text-gray-500">Consultor</label>
                <label className="inline-flex items-center gap-1.5 text-[11px] text-gray-500 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={mostrarComMeta}
                    onChange={(e) => setMostrarComMeta(e.target.checked)}
                    className="rounded border-gray-300"
                  />
                  Mostrar quem já tem meta
                </label>
              </div>
              <select
                value={consultorKey}
                onChange={(e) => {
                  setConsultorKey(e.target.value);
                  const found = catalogo.find((c) => c.nome === e.target.value);
                  if (found?.meta_marcados != null) setMeta(String(found.meta_marcados));
                }}
                className="w-full text-sm border border-gray-200 rounded-lg px-3 py-2 bg-white"
                required
              >
                <option value="">
                  {loading
                    ? 'Carregando consultores…'
                    : opcoesConsultor.length
                      ? 'Selecione um consultor'
                      : 'Nenhum consultor disponível'}
                </option>
                {opcoesConsultor.map((c) => (
                  <option key={`${c.origem}-${c.nome}`} value={c.nome}>
                    {c.nome}
                    {c.username ? ` (${c.username})` : ''}
                    {c.tem_meta ? ' — já tem meta' : ''}
                  </option>
                ))}
              </select>
              {selectedConsultor && (
                <p className="text-[11px] text-gray-500">
                  {selectedConsultor.username && (
                    <span className="font-mono">{selectedConsultor.username}</span>
                  )}
                  {selectedConsultor.username && ' · '}
                  Fonte: {selectedConsultor.origem === 'crm' ? 'usuários Acadêmico (CRM)' : 'histórico no disparador'}
                </p>
              )}
            </div>
            <div>
              <label className="block text-xs text-gray-500 mb-1">Meta diária (atendimentos)</label>
              <input
                type="number"
                min={0}
                value={meta}
                onChange={(e) => setMeta(e.target.value)}
                className="w-full text-sm border border-gray-200 rounded-lg px-3 py-2"
                required
              />
            </div>
          </div>
          <button
            type="submit"
            disabled={saving || !consultorKey}
            className="px-4 py-2 text-sm font-semibold text-white bg-whatsapp-500 rounded-lg hover:bg-whatsapp-600 disabled:opacity-60"
          >
            {saving ? 'Salvando…' : selectedConsultor?.tem_meta ? 'Atualizar meta' : 'Salvar meta'}
          </button>
        </form>

        <section className="rounded-xl border border-gray-100 bg-white shadow-sm overflow-hidden">
          <table className="min-w-full text-sm">
            <thead className="bg-gray-50 text-left text-xs text-gray-500 uppercase">
              <tr>
                <th className="px-4 py-2">Consultor</th>
                <th className="px-4 py-2 text-right">Meta/dia</th>
                <th className="px-4 py-2 w-12" />
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {loading && (
                <tr>
                  <td colSpan={3} className="px-4 py-8 text-center text-gray-400">
                    Carregando…
                  </td>
                </tr>
              )}
              {!loading && rows.length === 0 && (
                <tr>
                  <td colSpan={3} className="px-4 py-8 text-center text-gray-400">
                    Nenhuma meta para {anoMes}
                  </td>
                </tr>
              )}
              {!loading &&
                rows.map((r) => (
                  <tr key={r.id} className="hover:bg-gray-50/80">
                    <td className="px-4 py-2.5 font-medium text-gray-900">{r.consultor_nome}</td>
                    <td className="px-4 py-2.5 text-right tabular-nums">{r.meta_marcados}</td>
                    <td className="px-4 py-2.5 text-right">
                      <button
                        type="button"
                        onClick={() => void handleDelete(r.id)}
                        className="p-1.5 text-rose-600 hover:bg-rose-50 rounded"
                        title="Remover"
                      >
                        <Trash2 className="w-4 h-4" />
                      </button>
                    </td>
                  </tr>
                ))}
            </tbody>
          </table>
        </section>

        {!loading && catalogo.length > 0 && (
          <p className="text-xs text-gray-500">
            {catalogo.filter((c) => !c.tem_meta).length} consultor(es) sem meta em {anoMes} ·{' '}
            {catalogo.filter((c) => c.origem === 'crm').length} do CRM
          </p>
        )}
      </main>
    </div>
  );
}
