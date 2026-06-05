import { Loader2 } from 'lucide-react';

interface TableLoadingStateProps {
  colSpan: number;
  slow?: boolean;
  variant?: 'normal' | 'big';
}

export function TableLoadingState({ colSpan, slow = false, variant = 'normal' }: TableLoadingStateProps) {
  const isBig = variant === 'big';
  const paddingClass = isBig ? 'py-16' : 'py-10';
  const spinnerClass = isBig ? 'w-12 h-12' : 'w-8 h-8';
  const gapClass = isBig ? 'gap-4' : 'gap-3';

  return (
    <tr>
      <td colSpan={colSpan} className={`px-3 ${paddingClass} text-center`}>
        <div className={`flex flex-col items-center ${gapClass}`}>
          <Loader2 className={`${spinnerClass} animate-spin text-whatsapp-600 mx-auto`} />
          <p className="text-sm font-medium text-gray-700 dark:text-slate-300">
            {slow ? 'Montando fila (1ª abertura pode levar ~1 min)' : 'Carregando…'}
          </p>
          {slow && (
            <p className="text-xs text-gray-500 dark:text-slate-500">
              Cruzamento matrícula × base em andamento. Nas próximas vezes fica rápido.
            </p>
          )}
        </div>
      </td>
    </tr>
  );
}
