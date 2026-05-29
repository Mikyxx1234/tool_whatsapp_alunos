import { useCallback, useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { ArrowLeft, RefreshCw, X, Calendar } from 'lucide-react';
import { Header } from '../components/Header';
import { StudentTimeline } from '../components/StudentTimeline';
import { Toast, type ToastVariant } from '../components/Toast';
import {
  studentApi,
  type StudentDTO,
  type TimelineEvent,
  type ScheduledEventDTO,
} from '../services/studentApi';

interface ToastState {
  message: string;
  variant: ToastVariant;
  visible: boolean;
}

const FLOW_BADGE: Record<string, string> = {
  A: 'bg-emerald-50 text-emerald-700 border-emerald-200',
  B: 'bg-amber-50 text-amber-700 border-amber-200',
  C: 'bg-sky-50 text-sky-700 border-sky-200',
};

const EVENT_STATUS_BADGE: Record<string, string> = {
  pending: 'bg-blue-50 text-blue-700 border-blue-200',
  processing: 'bg-amber-50 text-amber-700 border-amber-200',
  sent: 'bg-emerald-50 text-emerald-700 border-emerald-200',
  failed: 'bg-rose-50 text-rose-700 border-rose-200',
  cancelled: 'bg-gray-100 text-gray-600 border-gray-200',
  skipped: 'bg-gray-100 text-gray-600 border-gray-200',
};

function formatDate(iso: string | null): string {
  if (!iso) return '—';
  try {
    return new Date(iso).toLocaleString('pt-BR');
  } catch {
    return iso;
  }
}

export default function StudentDetailPage() {
  const { id } = useParams<{ id: string }>();
  const [student, setStudent] = useState<StudentDTO | null>(null);
  const [timeline, setTimeline] = useState<TimelineEvent[]>([]);
  const [events, setEvents] = useState<ScheduledEventDTO[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [toast, setToast] = useState<ToastState>({
    message: '',
    variant: 'success',
    visible: false,
  });

  const showToast = (message: string, variant: ToastVariant = 'success') =>
    setToast({ message, variant, visible: true });

  const fetchAll = useCallback(async () => {
    if (!id) return;
    setLoading(true);
    setError(null);
    try {
      const [s, t, e] = await Promise.all([
        studentApi.get(id),
        studentApi.getTimeline(id),
        studentApi.getScheduledEvents(id),
      ]);
      setStudent(s.student);
      setTimeline(t.timeline);
      setEvents(e.events);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Erro ao carregar aluno');
    } finally {
      setLoading(false);
    }
  }, [id]);

  useEffect(() => {
    fetchAll();
  }, [fetchAll]);

  const handleRecalculate = async () => {
    if (!id) return;
    try {
      await studentApi.recalculateJourney(id);
      showToast('Régua recalculada.', 'success');
      await fetchAll();
    } catch (err) {
      showToast(err instanceof Error ? err.message : 'Erro', 'error');
    }
  };

  const handleCancelFuture = async () => {
    if (!id) return;
    try {
      const r = await studentApi.cancelFutureEvents(id, 'Cancelado manualmente');
      showToast(`${r.cancelled} evento(s) cancelado(s).`, 'info');
      await fetchAll();
    } catch (err) {
      showToast(err instanceof Error ? err.message : 'Erro', 'error');
    }
  };

  return (
    <div className="min-h-screen bg-gray-50">
      <Header showHistoryButton={false} />
      <main className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8 space-y-6">
        <Link
          to="/students"
          className="inline-flex items-center gap-1 text-sm text-gray-600 hover:text-gray-900"
        >
          <ArrowLeft className="w-4 h-4" />
          Voltar para alunos
        </Link>

        {error && (
          <div className="rounded-xl bg-rose-50 border border-rose-200 text-sm text-rose-700 p-3">
            {error}
          </div>
        )}

        {student && (
          <div className="bg-white rounded-2xl border border-gray-100 shadow-sm p-4 sm:p-6">
            <div className="flex flex-wrap items-start justify-between gap-4">
              <div>
                <h2 className="text-2xl font-semibold text-gray-900">
                  {student.nome}
                </h2>
                <div className="flex items-center gap-2 mt-2 flex-wrap">
                  {student.fluxo && (
                    <span
                      className={`inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium border ${
                        FLOW_BADGE[student.fluxo]
                      }`}
                    >
                      Fluxo {student.fluxo}
                    </span>
                  )}
                  <span className="inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium border bg-blue-50 text-blue-700 border-blue-200">
                    {student.status}
                  </span>
                </div>
              </div>
              <div className="flex gap-2 flex-wrap">
                <button
                  onClick={handleRecalculate}
                  className="inline-flex items-center gap-2 px-3 py-2 text-sm font-medium text-gray-700 bg-white border border-gray-200 rounded-lg hover:bg-gray-50"
                >
                  <RefreshCw className="w-4 h-4" />
                  Recalcular régua
                </button>
                <button
                  onClick={handleCancelFuture}
                  className="inline-flex items-center gap-2 px-3 py-2 text-sm font-medium text-rose-700 bg-rose-50 border border-rose-200 rounded-lg hover:bg-rose-100"
                >
                  <X className="w-4 h-4" />
                  Cancelar futuros
                </button>
              </div>
            </div>

            <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mt-6 text-sm">
              <Field label="Telefone" value={student.telefone_normalizado} mono />
              <Field label="E-mail" value={student.email} />
              <Field label="CPF" value={student.cpf} mono />
              <Field label="Curso" value={student.curso} />
              <Field label="Polo" value={student.polo} />
              <Field label="Data de matrícula" value={student.data_matricula} />
              <Field label="Início do conteúdo" value={student.data_inicio_conteudo} />
              <Field label="GAP (dias)" value={student.gap_dias?.toString()} />
              <Field label="Acesso liberado" value={student.data_acesso_liberado} />
              <Field label="Último acesso" value={student.ultimo_acesso ? formatDate(student.ultimo_acesso) : null} />
              <Field label="Engagement" value={student.engagement_score?.toString()} />
            </div>
          </div>
        )}

        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
          <div>
            <h3 className="text-base font-semibold text-gray-900 mb-3">
              Próximos eventos
            </h3>
            <div className="bg-white rounded-2xl border border-gray-100 shadow-sm overflow-hidden">
              <ul className="divide-y divide-gray-100">
                {events.length === 0 && (
                  <li className="px-4 py-6 text-center text-gray-500 text-sm">
                    Nenhum evento agendado.
                  </li>
                )}
                {events.map((ev) => (
                  <li key={ev.id} className="px-4 py-3 flex items-center gap-3">
                    <div className="w-9 h-9 bg-whatsapp-50 text-whatsapp-700 rounded-lg flex items-center justify-center shrink-0">
                      <Calendar className="w-4 h-4" />
                    </div>
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center justify-between gap-2 flex-wrap">
                        <p className="text-sm font-medium text-gray-900">
                          {ev.event_type || ev.canal}
                        </p>
                        <span
                          className={`inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium border ${
                            EVENT_STATUS_BADGE[ev.status] || 'bg-gray-50'
                          }`}
                        >
                          {ev.status}
                        </span>
                      </div>
                      <p className="text-xs text-gray-500 mt-0.5">
                        {formatDate(ev.execution_date)} · canal {ev.canal} · tentativas{' '}
                        {ev.attempts}/{ev.max_attempts}
                      </p>
                      {ev.last_error && (
                        <p className="text-xs text-rose-600 mt-0.5">
                          {ev.last_error}
                        </p>
                      )}
                    </div>
                  </li>
                ))}
              </ul>
            </div>
          </div>

          <div>
            <StudentTimeline events={timeline} />
          </div>
        </div>

        {loading && (
          <p className="text-center text-sm text-gray-500">Carregando...</p>
        )}
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

function Field({
  label,
  value,
  mono = false,
}: {
  label: string;
  value: string | null | undefined;
  mono?: boolean;
}) {
  return (
    <div>
      <p className="text-xs uppercase tracking-wide text-gray-500">{label}</p>
      <p
        className={`mt-0.5 text-gray-900 ${
          mono ? 'font-mono text-xs' : 'text-sm'
        }`}
      >
        {value || '—'}
      </p>
    </div>
  );
}
