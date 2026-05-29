import { Send, FileText, Users, Clock, Zap, FileCheck, Loader2 } from 'lucide-react';

interface CampaignSummaryProps {
  campaignName: string;
  fileName: string | null;
  validContacts: number;
  interval: string;
  templateName: string | null;
  isRunning: boolean;
  canStart: boolean;
  blockReason: string | null;
  onStartCampaign: () => void;
}

export function CampaignSummary({
  campaignName,
  fileName,
  validContacts,
  interval,
  templateName,
  isRunning,
  canStart,
  blockReason,
  onStartCampaign,
}: CampaignSummaryProps) {
  const estimatedTime = validContacts * (parseInt(interval) || 5);
  const minutes = Math.ceil(estimatedTime / 60);

  return (
    <div className="bg-white rounded-2xl border border-gray-100 p-6 shadow-sm">
      <h2 className="text-lg font-semibold text-gray-900 mb-4">Resumo da campanha</h2>
      <div className="space-y-3 mb-6">
        <SummaryRow icon={<Zap className="w-4 h-4 text-gray-500" />} label="Campanha" value={campaignName || 'Sem nome'} />
        <SummaryRow icon={<FileText className="w-4 h-4 text-gray-500" />} label="Arquivo" value={fileName || 'Nenhum arquivo'} />
        <SummaryRow icon={<FileCheck className="w-4 h-4 text-gray-500" />} label="Template" value={templateName || 'Nenhum'} />
        <SummaryRow
          icon={<Users className="w-4 h-4 text-gray-500" />}
          label="Contatos válidos"
          value={validContacts.toString()}
        />
        <SummaryRow
          icon={<Clock className="w-4 h-4 text-gray-500" />}
          label="Estimativa de tempo"
          value={`~${minutes} min`}
        />

        {canStart ? (
          <div className="flex items-center gap-3 p-3 bg-emerald-50 border border-emerald-100 rounded-lg">
            <div className="w-2 h-2 bg-emerald-500 rounded-full animate-pulse" />
            <p className="text-sm font-medium text-emerald-700">Pronto para disparar</p>
          </div>
        ) : (
          <div className="flex items-center gap-3 p-3 bg-amber-50 border border-amber-100 rounded-lg">
            <div className="w-2 h-2 bg-amber-500 rounded-full" />
            <p className="text-sm font-medium text-amber-700">{blockReason || 'Configure todos os campos'}</p>
          </div>
        )}
      </div>
      <button
        onClick={onStartCampaign}
        disabled={!canStart || isRunning}
        className="w-full flex items-center justify-center gap-2 px-6 py-3.5 bg-whatsapp-500 hover:bg-whatsapp-600 disabled:bg-gray-200 disabled:text-gray-400 disabled:cursor-not-allowed text-white font-semibold rounded-xl transition-colors shadow-lg shadow-whatsapp-500/20 disabled:shadow-none"
      >
        {isRunning ? (
          <>
            <Loader2 className="w-5 h-5 animate-spin" />
            Disparando...
          </>
        ) : (
          <>
            <Send className="w-5 h-5" />
            Iniciar disparo
          </>
        )}
      </button>
    </div>
  );
}

interface RowProps {
  icon: React.ReactNode;
  label: string;
  value: string;
}

function SummaryRow({ icon, label, value }: RowProps) {
  return (
    <div className="flex items-center gap-3 p-3 bg-gray-50 rounded-lg">
      {icon}
      <div className="flex-1 min-w-0">
        <p className="text-xs text-gray-500">{label}</p>
        <p className="text-sm font-medium text-gray-900 truncate">{value}</p>
      </div>
    </div>
  );
}
