import { useCallback, useEffect, useState } from 'react';
import { Plus, RefreshCw, Edit2, Trash2, Calculator } from 'lucide-react';
import { Header } from '../components/Header';
import { AcademicTermForm } from '../components/AcademicTermForm';
import { Toast, type ToastVariant } from '../components/Toast';
import {
  academicTermApi,
  type AcademicTermDTO,
  type AcademicTermInput,
} from '../services/academicTermApi';

interface ToastState {
  message: string;
  variant: ToastVariant;
  visible: boolean;
}

export default function AcademicTermsPage() {
  const [terms, setTerms] = useState<AcademicTermDTO[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState<AcademicTermDTO | 'new' | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [recalcLoading, setRecalcLoading] = useState<Record<string, boolean>>({});
  const [toast, setToast] = useState<ToastState>({
    message: '',
    variant: 'success',
    visible: false,
  });
  const showToast = (message: string, variant: ToastVariant = 'success') =>
    setToast({ message, variant, visible: true });

  const fetchAll = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const r = await academicTermApi.list({});
      setTerms(r.terms);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Erro ao carregar turmas');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchAll();
  }, [fetchAll]);

  const handleSave = async (input: AcademicTermInput) => {
    setSubmitting(true);
    try {
      if (editing === 'new') {
        await academicTermApi.create(input);
        showToast('Turma criada.');
      } else if (editing) {
        await academicTermApi.update(editing.id, input);
        showToast('Turma atualizada.');
      }
      setEditing(null);
      await fetchAll();
    } catch (err) {
      showToast(err instanceof Error ? err.message : 'Erro', 'error');
    } finally {
      setSubmitting(false);
    }
  };

  const handleDelete = async (term: AcademicTermDTO) => {
    if (!window.confirm(`Excluir turma "${term.codigo}"? Alunos vinculados ficarão sem turma.`)) {
      return;
    }
    try {
      await academicTermApi.remove(term.id);
      showToast('Turma excluída.', 'info');
      await fetchAll();
    } catch (err) {
      showToast(err instanceof Error ? err.message : 'Erro', 'error');
    }
  };

  const handleRecalculate = async (term: AcademicTermDTO) => {
    setRecalcLoading((s) => ({ ...s, [term.id]: true }));
    try {
      const r = await academicTermApi.recalculateStudents(term.id);
      showToast(
        `Recalculado: ${r.processed} aluno(s), ${r.totalEvents} evento(s) regerado(s).`,
        'success'
      );
      await fetchAll();
    } catch (err) {
      showToast(err instanceof Error ? err.message : 'Erro', 'error');
    } finally {
      setRecalcLoading((s) => ({ ...s, [term.id]: false }));
    }
  };

  return (
    <div className="min-h-screen bg-gray-50">
      <Header showHistoryButton={false} />

      <main className="max-w-6xl mx-auto px-4 sm:px-6 lg:px-8 py-8 space-y-6">
        <div className="flex items-end justify-between flex-wrap gap-3">
          <div>
            <h2 className="text-2xl font-semibold text-gray-900">Calendário Acadêmico</h2>
            <p className="text-sm text-gray-500 mt-1">
              Turmas/ciclos com datas, ambientação, atraso e tipo de início.
            </p>
            <div className="mt-2 text-xs text-amber-800 bg-amber-50 border border-amber-200 rounded-lg px-3 py-2 max-w-3xl">
              <strong>Regra ativa:</strong> alunos cuja data de matrícula cai em uma turma
              cujo <em>Início do conteúdo</em> ainda não chegou são automaticamente
              <strong> retirados da fila "Sem acesso BB"</strong> — eles ainda não têm
              matéria liberada no Blackboard, então não faz sentido cobrar acesso.
            </div>
          </div>
          <div className="flex gap-2">
            <button
              onClick={fetchAll}
              disabled={loading}
              className="inline-flex items-center gap-2 px-4 py-2 text-sm font-medium text-gray-700 bg-white border border-gray-200 rounded-lg hover:bg-gray-50 disabled:opacity-50"
            >
              <RefreshCw className={`w-4 h-4 ${loading ? 'animate-spin' : ''}`} />
              Atualizar
            </button>
            <button
              onClick={() => setEditing('new')}
              className="inline-flex items-center gap-2 px-4 py-2 text-sm font-medium text-white bg-whatsapp-500 rounded-lg hover:bg-whatsapp-600"
            >
              <Plus className="w-4 h-4" />
              Nova turma
            </button>
          </div>
        </div>

        {error && (
          <div className="rounded-xl bg-rose-50 border border-rose-200 text-sm text-rose-700 p-3">
            {error}
          </div>
        )}

        <div className="bg-white rounded-2xl border border-gray-100 shadow-sm overflow-hidden">
          <div className="overflow-x-auto">
            <table className="min-w-full text-sm">
              <thead className="bg-gray-50 text-gray-600">
                <tr>
                  <th className="px-3 py-2 text-left font-medium">Código</th>
                  <th className="px-3 py-2 text-left font-medium">Nome</th>
                  <th className="px-3 py-2 text-left font-medium">Início conteúdo</th>
                  <th className="px-3 py-2 text-center font-medium">Tipo início</th>
                  <th className="px-3 py-2 text-center font-medium">Ambientação</th>
                  <th className="px-3 py-2 text-center font-medium">Atraso</th>
                  <th className="px-3 py-2 text-right font-medium">Alunos</th>
                  <th className="px-3 py-2 text-right font-medium">Ações</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {terms.length === 0 && !loading && (
                  <tr>
                    <td colSpan={8} className="px-3 py-10 text-center text-gray-500">
                      Nenhuma turma cadastrada.
                    </td>
                  </tr>
                )}
                {terms.map((t) => (
                  <tr key={t.id} className="hover:bg-gray-50/60">
                    <td className="px-3 py-2 font-medium text-gray-900">
                      {t.codigo}
                      {!t.ativo && (
                        <span className="ml-2 text-xs text-gray-400">(inativa)</span>
                      )}
                    </td>
                    <td className="px-3 py-2 text-gray-700">{t.nome}</td>
                    <td className="px-3 py-2 text-gray-600">
                      {t.inicio_conteudo
                        ? new Date(t.inicio_conteudo).toLocaleDateString('pt-BR', {
                            timeZone: 'UTC',
                          })
                        : '—'}
                    </td>
                    <td className="px-3 py-2 text-center text-xs">
                      <span className="inline-flex items-center px-2 py-0.5 rounded-full bg-gray-100 text-gray-700 border border-gray-200">
                        {t.tipo_inicio}
                      </span>
                    </td>
                    <td className="px-3 py-2 text-center text-xs">
                      {t.tem_ambientacao ? (
                        <span className="text-emerald-700">{t.dias_ambientacao}d</span>
                      ) : (
                        <span className="text-gray-400">—</span>
                      )}
                    </td>
                    <td className="px-3 py-2 text-center text-xs">
                      {t.permitir_atraso ? (
                        <span className="text-amber-700">até {t.dias_atraso_max}d</span>
                      ) : (
                        <span className="text-gray-400">—</span>
                      )}
                    </td>
                    <td className="px-3 py-2 text-right text-gray-700">
                      {t.total_students || 0}
                    </td>
                    <td className="px-3 py-2 text-right">
                      <div className="flex justify-end gap-1">
                        <button
                          title="Recalcular régua"
                          onClick={() => handleRecalculate(t)}
                          disabled={recalcLoading[t.id]}
                          className="p-1.5 rounded-md hover:bg-gray-100 disabled:opacity-50"
                        >
                          <Calculator className="w-4 h-4 text-gray-500" />
                        </button>
                        <button
                          title="Editar"
                          onClick={() => setEditing(t)}
                          className="p-1.5 rounded-md hover:bg-gray-100"
                        >
                          <Edit2 className="w-4 h-4 text-gray-500" />
                        </button>
                        <button
                          title="Excluir"
                          onClick={() => handleDelete(t)}
                          className="p-1.5 rounded-md hover:bg-rose-50"
                        >
                          <Trash2 className="w-4 h-4 text-rose-500" />
                        </button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      </main>

      {editing && (
        <Modal onClose={() => setEditing(null)}>
          <h3 className="text-lg font-semibold text-gray-900 mb-4">
            {editing === 'new' ? 'Nova turma' : `Editar ${editing.codigo}`}
          </h3>
          <AcademicTermForm
            initial={editing === 'new' ? undefined : editing}
            onSubmit={handleSave}
            onCancel={() => setEditing(null)}
            submitting={submitting}
          />
        </Modal>
      )}

      <Toast
        message={toast.message}
        variant={toast.variant}
        isVisible={toast.visible}
        onClose={() => setToast((t) => ({ ...t, visible: false }))}
      />
    </div>
  );
}

function Modal({ children, onClose }: { children: React.ReactNode; onClose: () => void }) {
  return (
    <div
      className="fixed inset-0 z-50 bg-gray-900/40 flex items-center justify-center p-4"
      onClick={onClose}
    >
      <div
        className="bg-white rounded-2xl shadow-xl max-w-2xl w-full max-h-[90vh] overflow-y-auto"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="p-6">{children}</div>
      </div>
    </div>
  );
}
