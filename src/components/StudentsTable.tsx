import { Link } from 'react-router-dom';
import type { StudentDTO } from '../services/studentApi';

interface StudentsTableProps {
  students: StudentDTO[];
  onRecalculate: (id: string) => void;
  onCancelFuture: (id: string) => void;
  loadingActions?: Record<string, boolean>;
}

const FLOW_BADGE: Record<string, string> = {
  A: 'bg-emerald-50 text-emerald-700 border-emerald-200',
  B: 'bg-amber-50 text-amber-700 border-amber-200',
  C: 'bg-sky-50 text-sky-700 border-sky-200',
};

const STATUS_BADGE: Record<string, string> = {
  ativo: 'bg-blue-50 text-blue-700 border-blue-200',
  iniciado: 'bg-emerald-50 text-emerald-700 border-emerald-200',
  inativo: 'bg-gray-100 text-gray-600 border-gray-200',
  cancelado: 'bg-rose-50 text-rose-700 border-rose-200',
};

export function StudentsTable({
  students,
  onRecalculate,
  onCancelFuture,
  loadingActions = {},
}: StudentsTableProps) {
  return (
    <div className="bg-white rounded-2xl border border-gray-100 shadow-sm overflow-hidden">
      <div className="overflow-x-auto">
        <table className="min-w-full text-sm">
          <thead className="bg-gray-50 text-gray-600">
            <tr>
              <th className="px-3 py-2 text-left font-medium">Aluno</th>
              <th className="px-3 py-2 text-left font-medium">Telefone</th>
              <th className="px-3 py-2 text-center font-medium">Fluxo</th>
              <th className="px-3 py-2 text-center font-medium">Status</th>
              <th className="px-3 py-2 text-right font-medium">GAP</th>
              <th className="px-3 py-2 text-left font-medium">Início conteúdo</th>
              <th className="px-3 py-2 text-right font-medium">Ações</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-100">
            {students.map((s) => (
              <tr key={s.id} className="hover:bg-gray-50/60">
                <td className="px-3 py-2">
                  <Link
                    to={`/students/${s.id}`}
                    className="font-medium text-whatsapp-700 hover:underline"
                  >
                    {s.nome}
                  </Link>
                  {s.email && (
                    <div className="text-xs text-gray-500">{s.email}</div>
                  )}
                </td>
                <td className="px-3 py-2 font-mono text-xs text-gray-700">
                  {s.telefone_normalizado || s.telefone || '—'}
                </td>
                <td className="px-3 py-2 text-center">
                  {s.fluxo ? (
                    <span
                      className={`inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium border ${
                        FLOW_BADGE[s.fluxo] || 'bg-gray-50 text-gray-600'
                      }`}
                    >
                      Fluxo {s.fluxo}
                    </span>
                  ) : (
                    <span className="text-xs text-gray-400">—</span>
                  )}
                </td>
                <td className="px-3 py-2 text-center">
                  <span
                    className={`inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium border ${
                      STATUS_BADGE[s.status] || 'bg-gray-50'
                    }`}
                  >
                    {s.status}
                  </span>
                </td>
                <td className="px-3 py-2 text-right text-gray-700">
                  {s.gap_dias === null ? '—' : s.gap_dias}
                </td>
                <td className="px-3 py-2 text-gray-600">
                  {s.data_inicio_conteudo || '—'}
                </td>
                <td className="px-3 py-2 text-right">
                  <div className="flex justify-end gap-2">
                    <button
                      onClick={() => onRecalculate(s.id)}
                      disabled={loadingActions[s.id]}
                      className="text-xs px-2 py-1 rounded-md bg-gray-100 hover:bg-gray-200 disabled:opacity-50"
                    >
                      Recalcular
                    </button>
                    <button
                      onClick={() => onCancelFuture(s.id)}
                      disabled={loadingActions[s.id]}
                      className="text-xs px-2 py-1 rounded-md bg-rose-50 text-rose-700 hover:bg-rose-100 disabled:opacity-50"
                    >
                      Cancelar futuros
                    </button>
                  </div>
                </td>
              </tr>
            ))}
            {students.length === 0 && (
              <tr>
                <td colSpan={7} className="px-3 py-10 text-center text-gray-500">
                  Nenhum aluno encontrado.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
