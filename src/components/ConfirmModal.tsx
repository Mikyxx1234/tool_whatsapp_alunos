import { AlertTriangle, X } from 'lucide-react';

interface ConfirmModalProps {
  isOpen: boolean;
  campaignName: string;
  templateName: string | null;
  validContacts: number;
  intervalSeconds: number;
  onCancel: () => void;
  onConfirm: () => void;
}

export function ConfirmModal({
  isOpen,
  campaignName,
  templateName,
  validContacts,
  intervalSeconds,
  onCancel,
  onConfirm,
}: ConfirmModalProps) {
  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-black/40 backdrop-blur-sm" onClick={onCancel} />
      <div className="relative bg-white rounded-2xl shadow-2xl w-full max-w-md p-6 animate-in">
        <button
          onClick={onCancel}
          className="absolute top-4 right-4 p-1.5 text-gray-400 hover:text-gray-600 rounded-lg hover:bg-gray-100 transition-colors"
          aria-label="Fechar"
        >
          <X className="w-5 h-5" />
        </button>

        <div className="flex items-center gap-3 mb-4">
          <div className="w-10 h-10 bg-amber-100 rounded-full flex items-center justify-center">
            <AlertTriangle className="w-5 h-5 text-amber-600" />
          </div>
          <h3 className="text-lg font-semibold text-gray-900">Confirmar disparo?</h3>
        </div>

        <p className="text-sm text-gray-500 mb-4">
          As mensagens serão enviadas em sequência respeitando o intervalo configurado.
          Confira os dados antes de iniciar.
        </p>

        <div className="p-3 bg-gray-50 rounded-lg mb-6 space-y-1.5">
          <Row label="Campanha" value={campaignName || 'Sem nome'} />
          <Row label="Template" value={templateName || '—'} />
          <Row label="Contatos" value={validContacts.toLocaleString()} />
          <Row label="Intervalo" value={`${intervalSeconds}s entre envios`} />
        </div>

        <div className="flex gap-3">
          <button
            onClick={onCancel}
            className="flex-1 px-4 py-2.5 text-sm font-medium text-gray-700 bg-white border border-gray-200 rounded-lg hover:bg-gray-50 transition-colors"
          >
            Cancelar
          </button>
          <button
            onClick={onConfirm}
            className="flex-1 px-4 py-2.5 text-sm font-medium text-white bg-whatsapp-500 hover:bg-whatsapp-600 rounded-lg transition-colors"
          >
            Confirmar disparo
          </button>
        </div>
      </div>
    </div>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex justify-between text-sm gap-4">
      <span className="text-gray-500">{label}:</span>
      <span className="font-medium text-gray-900 truncate text-right">{value}</span>
    </div>
  );
}
