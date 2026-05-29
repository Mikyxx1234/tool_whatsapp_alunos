import { CheckCircle, X, AlertCircle, Info } from 'lucide-react';
import { useEffect } from 'react';

export type ToastVariant = 'success' | 'error' | 'info';

interface ToastProps {
  message: string;
  variant?: ToastVariant;
  isVisible: boolean;
  onClose: () => void;
}

const variantConfig = {
  success: { icon: CheckCircle, color: 'text-emerald-400' },
  error: { icon: AlertCircle, color: 'text-red-400' },
  info: { icon: Info, color: 'text-blue-400' },
};

export function Toast({ message, variant = 'success', isVisible, onClose }: ToastProps) {
  useEffect(() => {
    if (isVisible) {
      const timer = setTimeout(onClose, 4000);
      return () => clearTimeout(timer);
    }
  }, [isVisible, onClose]);

  if (!isVisible) return null;

  const { icon: Icon, color } = variantConfig[variant];

  return (
    <div className="fixed bottom-6 right-6 z-50 animate-in">
      <div className="flex items-center gap-3 px-4 py-3 bg-gray-900 text-white rounded-xl shadow-xl max-w-md">
        <Icon className={`w-5 h-5 flex-shrink-0 ${color}`} />
        <p className="text-sm font-medium">{message}</p>
        <button
          onClick={onClose}
          className="p-1 hover:bg-gray-700 rounded-md transition-colors"
          aria-label="Fechar"
        >
          <X className="w-4 h-4" />
        </button>
      </div>
    </div>
  );
}
