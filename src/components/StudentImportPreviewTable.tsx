import { AlertCircle, CheckCircle2 } from 'lucide-react';
import type { StudentImportRow } from '../services/studentCsvParser';

interface StudentImportPreviewTableProps {
  rows: StudentImportRow[];
  maxRows?: number;
}

const FLOW_BADGE: Record<string, string> = {
  A: 'bg-emerald-50 text-emerald-700 border-emerald-200',
  B: 'bg-amber-50 text-amber-700 border-amber-200',
  C: 'bg-sky-50 text-sky-700 border-sky-200',
};

export function StudentImportPreviewTable({
  rows,
  maxRows = 100,
}: StudentImportPreviewTableProps) {
  const display = rows.slice(0, maxRows);
  const totalErrors = rows.filter((r) => r.errors.length > 0).length;

  return (
    <div className="bg-white rounded-2xl border border-gray-100 shadow-sm overflow-hidden">
      <div className="px-4 sm:px-6 py-4 border-b border-gray-100 flex items-center justify-between">
        <div>
          <h3 className="text-base font-semibold text-gray-900">
            Pré-visualização da importação
          </h3>
          <p className="text-xs text-gray-500 mt-0.5">
            {rows.length} linha(s) lida(s)
            {totalErrors > 0 && (
              <span className="text-rose-600">
                {' '}
                · {totalErrors} com erro(s)
              </span>
            )}
            {rows.length > maxRows && (
              <span className="text-gray-400"> · exibindo {maxRows}</span>
            )}
          </p>
        </div>
      </div>

      <div className="overflow-x-auto">
        <table className="min-w-full text-sm">
          <thead className="bg-gray-50 text-gray-600">
            <tr>
              <th className="px-3 py-2 text-left font-medium">Status</th>
              <th className="px-3 py-2 text-left font-medium">Nome</th>
              <th className="px-3 py-2 text-left font-medium">Telefone</th>
              <th className="px-3 py-2 text-left font-medium">Matrícula</th>
              <th className="px-3 py-2 text-left font-medium">Início conteúdo</th>
              <th className="px-3 py-2 text-right font-medium">GAP (dias)</th>
              <th className="px-3 py-2 text-center font-medium">Fluxo</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-100">
            {display.map((row, idx) => {
              const hasError = row.errors.length > 0;
              return (
                <tr key={idx} className={hasError ? 'bg-rose-50/40' : ''}>
                  <td className="px-3 py-2">
                    {hasError ? (
                      <div className="flex items-center gap-1.5 text-rose-600">
                        <AlertCircle className="w-4 h-4" />
                        <span className="text-xs">erro</span>
                      </div>
                    ) : (
                      <div className="flex items-center gap-1.5 text-emerald-600">
                        <CheckCircle2 className="w-4 h-4" />
                        <span className="text-xs">ok</span>
                      </div>
                    )}
                  </td>
                  <td className="px-3 py-2 text-gray-900">{row.nome || '—'}</td>
                  <td className="px-3 py-2 text-gray-700 font-mono text-xs">
                    {row.telefoneNormalizado || row.telefone || '—'}
                  </td>
                  <td className="px-3 py-2 text-gray-600">
                    {row.dataMatricula || '—'}
                  </td>
                  <td className="px-3 py-2 text-gray-600">
                    {row.dataInicio || '—'}
                  </td>
                  <td className="px-3 py-2 text-right text-gray-700">
                    {row.gapDias === null ? '—' : row.gapDias}
                  </td>
                  <td className="px-3 py-2 text-center">
                    {row.fluxo ? (
                      <span
                        className={`inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium border ${
                          FLOW_BADGE[row.fluxo] || 'bg-gray-50 text-gray-600'
                        }`}
                      >
                        Fluxo {row.fluxo}
                      </span>
                    ) : (
                      <span className="text-xs text-gray-400">—</span>
                    )}
                  </td>
                </tr>
              );
            })}
            {display.length === 0 && (
              <tr>
                <td colSpan={7} className="px-3 py-8 text-center text-gray-500">
                  Nenhuma linha para exibir.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      {totalErrors > 0 && (
        <div className="border-t border-gray-100 px-4 sm:px-6 py-3 bg-rose-50/40">
          <details>
            <summary className="cursor-pointer text-xs font-medium text-rose-700">
              Ver detalhes dos erros
            </summary>
            <ul className="mt-2 space-y-1 text-xs text-rose-700">
              {rows
                .map((r, i) => ({ row: r, idx: i }))
                .filter(({ row }) => row.errors.length > 0)
                .slice(0, 30)
                .map(({ row, idx }) => (
                  <li key={idx}>
                    Linha {idx + 1}: {row.errors.join(' · ')}
                  </li>
                ))}
            </ul>
          </details>
        </div>
      )}
    </div>
  );
}
