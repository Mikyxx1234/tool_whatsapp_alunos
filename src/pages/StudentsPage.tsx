import { useCallback, useEffect, useMemo, useState } from 'react';
import { Search, RefreshCw } from 'lucide-react';
import { Header } from '../components/Header';
import { StudentsTable } from '../components/StudentsTable';
import { Toast, type ToastVariant } from '../components/Toast';
import { studentApi, type StudentDTO } from '../services/studentApi';

interface ToastState {
  message: string;
  variant: ToastVariant;
  visible: boolean;
}

const FLOW_OPTIONS = ['', 'A', 'B', 'C'];
const STATUS_OPTIONS = ['', 'ativo', 'iniciado', 'inativo', 'cancelado'];

export default function StudentsPage() {
  const [students, setStudents] = useState<StudentDTO[]>([]);
  const [search, setSearch] = useState('');
  const [fluxo, setFluxo] = useState('');
  const [status, setStatus] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loadingActions, setLoadingActions] = useState<Record<string, boolean>>({});

  const [toast, setToast] = useState<ToastState>({
    message: '',
    variant: 'success',
    visible: false,
  });

  const showToast = (message: string, variant: ToastVariant = 'success') =>
    setToast({ message, variant, visible: true });

  const fetchStudents = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const r = await studentApi.list({
        fluxo: fluxo || undefined,
        status: status || undefined,
        search: search || undefined,
        limit: 200,
      });
      setStudents(r.students);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Erro ao carregar alunos');
    } finally {
      setLoading(false);
    }
  }, [fluxo, status, search]);

  useEffect(() => {
    fetchStudents();
  }, [fetchStudents]);

  const counts = useMemo(() => {
    const out = { total: students.length, A: 0, B: 0, C: 0, indef: 0 };
    for (const s of students) {
      if (s.fluxo === 'A') out.A += 1;
      else if (s.fluxo === 'B') out.B += 1;
      else if (s.fluxo === 'C') out.C += 1;
      else out.indef += 1;
    }
    return out;
  }, [students]);

  const handleRecalculate = async (id: string) => {
    setLoadingActions((s) => ({ ...s, [id]: true }));
    try {
      await studentApi.recalculateJourney(id);
      showToast('Régua recalculada e eventos regerados.', 'success');
      await fetchStudents();
    } catch (err) {
      showToast(err instanceof Error ? err.message : 'Erro', 'error');
    } finally {
      setLoadingActions((s) => ({ ...s, [id]: false }));
    }
  };

  const handleCancelFuture = async (id: string) => {
    setLoadingActions((s) => ({ ...s, [id]: true }));
    try {
      const r = await studentApi.cancelFutureEvents(id, 'Cancelado pelo usuário');
      showToast(`${r.cancelled} evento(s) cancelado(s).`, 'info');
      await fetchStudents();
    } catch (err) {
      showToast(err instanceof Error ? err.message : 'Erro', 'error');
    } finally {
      setLoadingActions((s) => ({ ...s, [id]: false }));
    }
  };

  return (
    <div className="min-h-screen bg-gray-50">
      <Header showHistoryButton={false} />
      <main className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8 space-y-6">
        <div className="flex items-end justify-between flex-wrap gap-3">
          <div>
            <h2 className="text-2xl font-semibold text-gray-900">Alunos</h2>
            <p className="text-sm text-gray-500 mt-1">
              Régua Inteligente — visualize e gerencie alunos importados.
            </p>
          </div>
          <button
            onClick={fetchStudents}
            disabled={loading}
            className="inline-flex items-center gap-2 px-4 py-2 text-sm font-medium text-gray-700 bg-white border border-gray-200 rounded-lg hover:bg-gray-50 disabled:opacity-50"
          >
            <RefreshCw className={`w-4 h-4 ${loading ? 'animate-spin' : ''}`} />
            Atualizar
          </button>
        </div>

        <div className="grid grid-cols-2 md:grid-cols-5 gap-3">
          <div className="bg-white rounded-xl border border-gray-100 p-4">
            <p className="text-xs text-gray-500">Total</p>
            <p className="text-xl font-semibold mt-1">{counts.total}</p>
          </div>
          <div className="bg-emerald-50 rounded-xl border border-emerald-200 p-4">
            <p className="text-xs text-emerald-700">Fluxo A</p>
            <p className="text-xl font-semibold text-emerald-800 mt-1">{counts.A}</p>
          </div>
          <div className="bg-amber-50 rounded-xl border border-amber-200 p-4">
            <p className="text-xs text-amber-700">Fluxo B</p>
            <p className="text-xl font-semibold text-amber-800 mt-1">{counts.B}</p>
          </div>
          <div className="bg-sky-50 rounded-xl border border-sky-200 p-4">
            <p className="text-xs text-sky-700">Fluxo C</p>
            <p className="text-xl font-semibold text-sky-800 mt-1">{counts.C}</p>
          </div>
          <div className="bg-gray-50 rounded-xl border border-gray-200 p-4">
            <p className="text-xs text-gray-600">Indefinido</p>
            <p className="text-xl font-semibold text-gray-800 mt-1">{counts.indef}</p>
          </div>
        </div>

        <div className="bg-white rounded-2xl border border-gray-100 shadow-sm p-4 flex flex-wrap gap-3">
          <div className="relative flex-1 min-w-[220px]">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400" />
            <input
              type="text"
              placeholder="Buscar por nome, e-mail, telefone, CPF"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="w-full pl-9 pr-3 py-2 border border-gray-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-whatsapp-500"
            />
          </div>
          <select
            value={fluxo}
            onChange={(e) => setFluxo(e.target.value)}
            className="px-3 py-2 border border-gray-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-whatsapp-500"
          >
            {FLOW_OPTIONS.map((f) => (
              <option key={f} value={f}>
                {f === '' ? 'Todos os fluxos' : `Fluxo ${f}`}
              </option>
            ))}
          </select>
          <select
            value={status}
            onChange={(e) => setStatus(e.target.value)}
            className="px-3 py-2 border border-gray-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-whatsapp-500"
          >
            {STATUS_OPTIONS.map((s) => (
              <option key={s} value={s}>
                {s === '' ? 'Todos os status' : s}
              </option>
            ))}
          </select>
        </div>

        {error && (
          <div className="rounded-xl bg-rose-50 border border-rose-200 text-sm text-rose-700 p-3">
            {error}
          </div>
        )}

        <StudentsTable
          students={students}
          onRecalculate={handleRecalculate}
          onCancelFuture={handleCancelFuture}
          loadingActions={loadingActions}
        />
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
