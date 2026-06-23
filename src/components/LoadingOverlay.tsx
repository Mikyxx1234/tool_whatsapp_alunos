import { useEffect } from 'react';
import { Loader2, Check, Circle, X } from 'lucide-react';

interface ProgressInfo {
  processed: number;
  total: number;
  percent: number;
  stats?: string;
}

interface LoadingOverlayProps {
  open: boolean;
  title: string;
  subtitle?: string;
  hint?: string;
  stages?: string[];
  currentStageIndex?: number;
  onClose?: () => void;
  onCancel?: () => void;
  progress?: ProgressInfo;
}

export function LoadingOverlay({
  open,
  title,
  subtitle,
  hint,
  stages,
  currentStageIndex,
  onClose,
  onCancel,
  progress,
}: LoadingOverlayProps) {
  useEffect(() => {
    if (open) {
      document.body.style.overflow = 'hidden';
    } else {
      document.body.style.overflow = '';
    }
    return () => {
      document.body.style.overflow = '';
    };
  }, [open]);

  useEffect(() => {
    if (!onClose) return;
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', handleKey);
    return () => document.removeEventListener('keydown', handleKey);
  }, [onClose]);

  if (!open) return null;

  const hasStages = stages && stages.length > 0 && currentStageIndex !== undefined;

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={title}
      className="fixed inset-0 z-50 bg-black/40 backdrop-blur-sm flex items-center justify-center p-4"
    >
      <div className="bg-white dark:bg-slate-900 rounded-2xl shadow-2xl w-full max-w-[440px] p-8 relative">
        {onClose && (
          <button
            type="button"
            onClick={onClose}
            title="Esconder (a operação continua em segundo plano)"
            aria-label="Minimizar"
            className="absolute top-4 right-4 p-1.5 rounded-md text-gray-400 hover:text-gray-700 hover:bg-gray-100 dark:text-slate-500 dark:hover:text-slate-300 dark:hover:bg-slate-800"
          >
            <X className="w-4 h-4" />
          </button>
        )}

        <div className="flex flex-col items-center text-center gap-4">
          <Loader2 className="w-14 h-14 animate-spin text-whatsapp-600" />

          <div className="space-y-1">
            <h2 className="text-lg font-semibold text-gray-900 dark:text-slate-100">
              {title}
            </h2>
            {subtitle && (
              <p className="text-sm text-gray-600 dark:text-slate-400">{subtitle}</p>
            )}
          </div>

          {hasStages && (
            <div className="w-full text-left space-y-2 mt-1">
              {stages!.map((stage, i) => {
                const isDone = i < currentStageIndex!;
                const isActive = i === currentStageIndex!;
                return (
                  <div key={i} className="flex items-center gap-2.5">
                    <span className="shrink-0">
                      {isDone ? (
                        <Check className="w-4 h-4 text-emerald-500" />
                      ) : isActive ? (
                        <Loader2 className="w-4 h-4 animate-spin text-blue-500" />
                      ) : (
                        <Circle className="w-4 h-4 text-gray-300 dark:text-slate-600" />
                      )}
                    </span>
                    <span
                      className={`text-sm ${
                        isDone
                          ? 'text-emerald-600 dark:text-emerald-400 line-through'
                          : isActive
                          ? 'text-gray-900 dark:text-slate-100 font-medium'
                          : 'text-gray-400 dark:text-slate-500'
                      }`}
                    >
                      {stage}
                    </span>
                  </div>
                );
              })}
            </div>
          )}

          {progress && (
            <div className="w-full space-y-1.5 mt-1">
              <div className="w-full h-2 rounded-full bg-gray-200 dark:bg-slate-800 overflow-hidden">
                {progress.total === 0 ? (
                  <div className="h-full w-full bg-whatsapp-600 animate-pulse" />
                ) : (
                  <div
                    className="h-full bg-whatsapp-600 rounded-full transition-all duration-500 ease-out"
                    style={{ width: `${progress.percent}%` }}
                  />
                )}
              </div>
              <p className="text-xs text-gray-700 dark:text-slate-300 text-center">
                {progress.total === 0 ? (
                  'Preparando…'
                ) : (
                  <>
                    <strong>{progress.percent}%</strong>
                    {' · '}
                    {progress.processed.toLocaleString('pt-BR')} de{' '}
                    {progress.total.toLocaleString('pt-BR')}
                  </>
                )}
              </p>
              {progress.stats && (
                <p className="text-[11px] text-gray-500 dark:text-slate-500 text-center">
                  {progress.stats}
                </p>
              )}
            </div>
          )}

          {hint && (
            <p className="text-[11px] text-gray-500 dark:text-slate-500 mt-1">{hint}</p>
          )}

          {onCancel && (
            <button
              type="button"
              onClick={onCancel}
              className="mt-2 px-4 py-2 text-sm font-medium text-rose-700 dark:text-rose-300 bg-rose-50 dark:bg-rose-950/40 border border-rose-200 dark:border-rose-800 rounded-lg hover:bg-rose-100 dark:hover:bg-rose-950/60"
            >
              Interromper disparo
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
