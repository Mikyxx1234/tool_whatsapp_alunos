import { Activity, Pause, CheckCircle2, XCircle, Clock } from 'lucide-react';
import type { CampaignProgress as Progress, CampaignStatusType } from '../types';

interface CampaignProgressProps {
  progress: Progress;
  status: CampaignStatusType;
  onCancel: () => void;
}

export function CampaignProgress({ progress, status, onCancel }: CampaignProgressProps) {
  const percent = progress.total === 0 ? 0 : Math.round((progress.sent + progress.failed) / progress.total * 100);

  const statusLabel: Record<CampaignStatusType, string> = {
    idle: 'Aguardando',
    running: 'Em andamento',
    completed: 'Concluída',
    cancelled: 'Cancelada',
    failed: 'Com erros',
  };

  const statusClass: Record<CampaignStatusType, string> = {
    idle: 'bg-gray-50 text-gray-600 border-gray-200',
    running: 'bg-blue-50 text-blue-700 border-blue-200',
    completed: 'bg-emerald-50 text-emerald-700 border-emerald-200',
    cancelled: 'bg-amber-50 text-amber-700 border-amber-200',
    failed: 'bg-red-50 text-red-700 border-red-200',
  };

  return (
    <div className="bg-white rounded-2xl border border-gray-100 p-6 shadow-sm">
      <div className="flex items-center justify-between mb-4">
        <h2 className="text-lg font-semibold text-gray-900 flex items-center gap-2">
          <Activity className="w-5 h-5 text-gray-500" />
          Progresso do disparo
        </h2>
        <span
          className={`inline-flex items-center px-2.5 py-1 rounded-md text-xs font-medium border ${statusClass[status]}`}
        >
          {statusLabel[status]}
        </span>
      </div>

      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-4">
        <Stat icon={Clock} label="Pendentes" value={progress.pending} color="text-gray-700 bg-gray-50" />
        <Stat icon={Activity} label="Total" value={progress.total} color="text-blue-700 bg-blue-50" />
        <Stat icon={CheckCircle2} label="Enviadas" value={progress.sent} color="text-emerald-700 bg-emerald-50" />
        <Stat icon={XCircle} label="Falhas" value={progress.failed} color="text-red-700 bg-red-50" />
      </div>

      <div>
        <div className="flex justify-between text-xs text-gray-500 mb-1">
          <span>Progresso</span>
          <span>{percent}%</span>
        </div>
        <div className="w-full h-2 bg-gray-100 rounded-full overflow-hidden">
          <div
            className="h-full bg-whatsapp-500 rounded-full transition-all duration-500"
            style={{ width: `${percent}%` }}
          />
        </div>
      </div>

      {status === 'running' && (
        <button
          onClick={onCancel}
          className="mt-4 w-full inline-flex items-center justify-center gap-2 px-4 py-2.5 text-sm font-medium text-red-700 bg-red-50 hover:bg-red-100 border border-red-200 rounded-lg transition-colors"
        >
          <Pause className="w-4 h-4" />
          Cancelar disparo
        </button>
      )}
    </div>
  );
}

interface StatProps {
  icon: typeof Activity;
  label: string;
  value: number;
  color: string;
}

function Stat({ icon: Icon, label, value, color }: StatProps) {
  const [textColor, bgColor] = color.split(' ');
  return (
    <div className="p-3 rounded-xl border border-gray-100">
      <div className={`w-7 h-7 rounded-md flex items-center justify-center mb-2 ${bgColor}`}>
        <Icon className={`w-3.5 h-3.5 ${textColor}`} />
      </div>
      <p className="text-lg font-semibold text-gray-900">{value}</p>
      <p className="text-[11px] text-gray-500">{label}</p>
    </div>
  );
}
