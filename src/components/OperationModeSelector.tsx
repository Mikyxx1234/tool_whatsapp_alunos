import { Send, GraduationCap, Zap } from 'lucide-react';

export type OperationMode = 'manual' | 'journey' | 'activation';

interface OperationModeSelectorProps {
  mode: OperationMode;
  onChange: (mode: OperationMode) => void;
}

const OPTIONS: Array<{
  id: OperationMode;
  title: string;
  description: string;
  icon: typeof Send;
}> = [
  {
    id: 'manual',
    title: 'Disparo manual',
    description: 'Sobe um CSV, escolhe o template e envia agora.',
    icon: Send,
  },
  {
    id: 'journey',
    title: 'Régua Inteligente',
    description: 'Importa alunos, classifica e agenda mensagens automáticas.',
    icon: GraduationCap,
  },
  {
    id: 'activation',
    title: 'Ativação por bases',
    description: 'Docs, inadimplentes, Blackboard e CAA: buscar no DataCrazy e disparar templates.',
    icon: Zap,
  },
];

export function OperationModeSelector({ mode, onChange }: OperationModeSelectorProps) {
  return (
    <div className="bg-white rounded-2xl border border-gray-100 shadow-sm p-4 sm:p-6">
      <div className="flex items-center justify-between mb-4">
        <h2 className="text-base font-semibold text-gray-900">Modo de operação</h2>
        <span className="text-xs text-gray-400">
          Escolha o tipo de campanha que vai operar agora.
        </span>
      </div>
      <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
        {OPTIONS.map((opt) => {
          const Icon = opt.icon;
          const active = mode === opt.id;
          return (
            <button
              key={opt.id}
              type="button"
              onClick={() => onChange(opt.id)}
              className={`text-left p-4 rounded-xl border transition-all ${
                active
                  ? 'border-whatsapp-500 bg-whatsapp-50 ring-1 ring-whatsapp-500'
                  : 'border-gray-200 hover:border-gray-300 hover:bg-gray-50'
              }`}
            >
              <div className="flex items-start gap-3">
                <div
                  className={`w-10 h-10 rounded-lg flex items-center justify-center shrink-0 ${
                    active
                      ? 'bg-whatsapp-500 text-white'
                      : 'bg-gray-100 text-gray-600'
                  }`}
                >
                  <Icon className="w-5 h-5" />
                </div>
                <div>
                  <p
                    className={`text-sm font-semibold ${
                      active ? 'text-whatsapp-700' : 'text-gray-900'
                    }`}
                  >
                    {opt.title}
                  </p>
                  <p className="text-xs text-gray-500 mt-0.5">{opt.description}</p>
                </div>
              </div>
            </button>
          );
        })}
      </div>
    </div>
  );
}
