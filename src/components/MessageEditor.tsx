import { Clock, Hash, Info, AlertTriangle } from 'lucide-react';

const RECOMMENDED_INTERVAL_SECONDS = 2;
const MIN_ALLOWED_INTERVAL = 1;

interface MessageEditorProps {
  campaignName: string;
  onCampaignNameChange: (name: string) => void;
  interval: string;
  onIntervalChange: (val: string) => void;
  dailyLimit: string;
  onDailyLimitChange: (val: string) => void;
  templateSelected: boolean;
}

export function MessageEditor({
  campaignName,
  onCampaignNameChange,
  interval,
  onIntervalChange,
  dailyLimit,
  onDailyLimitChange,
  templateSelected,
}: MessageEditorProps) {
  return (
    <div className="bg-white rounded-2xl border border-gray-100 p-6 shadow-sm">
      <h2 className="text-lg font-semibold text-gray-900 mb-4">Configuração da campanha</h2>

      <div className="space-y-4">
        <div>
          <label className="block text-sm font-medium text-gray-700 mb-1.5">
            Nome da campanha
          </label>
          <input
            type="text"
            value={campaignName}
            onChange={(e) => onCampaignNameChange(e.target.value)}
            placeholder="Ex: Promoção de Maio"
            className="w-full px-3 py-2.5 text-sm border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-whatsapp-500/20 focus:border-whatsapp-500"
          />
        </div>

        {!templateSelected && (
          <p className="text-xs text-amber-700 bg-amber-50 border border-amber-100 rounded-md px-2 py-1.5">
            Selecione um template aprovado para liberar o envio.
          </p>
        )}

        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1.5 flex items-center gap-1.5">
              <Clock className="w-4 h-4" />
              Intervalo (s)
            </label>
            <input
              type="number"
              value={interval}
              onChange={(e) => onIntervalChange(e.target.value)}
              placeholder="2"
              min={MIN_ALLOWED_INTERVAL}
              step="1"
              className="w-full px-3 py-2.5 text-sm border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-whatsapp-500/20 focus:border-whatsapp-500"
            />
            <p className="text-xs text-gray-400 mt-1">
              Mínimo {MIN_ALLOWED_INTERVAL}s · sugerido {RECOMMENDED_INTERVAL_SECONDS}s
            </p>
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1.5 flex items-center gap-1.5">
              <Hash className="w-4 h-4" />
              Limite diário
            </label>
            <input
              type="number"
              value={dailyLimit}
              onChange={(e) => onDailyLimitChange(e.target.value)}
              placeholder="500"
              min="0"
              className="w-full px-3 py-2.5 text-sm border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-whatsapp-500/20 focus:border-whatsapp-500"
            />
            <p className="text-xs text-gray-400 mt-1">Máximo por dia</p>
          </div>
        </div>

        <IntervalGuideline interval={interval} />
      </div>
    </div>
  );
}

function IntervalGuideline({ interval }: { interval: string }) {
  const n = parseInt(interval, 10);
  const isLow = Number.isFinite(n) && n > 0 && n < RECOMMENDED_INTERVAL_SECONDS;
  const isInvalid = Number.isFinite(n) && n < MIN_ALLOWED_INTERVAL;

  if (isInvalid) {
    return (
      <div className="flex items-start gap-2 p-3 bg-red-50 border border-red-100 rounded-lg">
        <AlertTriangle className="w-4 h-4 text-red-600 flex-shrink-0 mt-0.5" />
        <div className="text-xs text-red-800">
          O backend nunca enviará com intervalo abaixo de {MIN_ALLOWED_INTERVAL}s
          (limite do provedor). Esse valor será automaticamente ajustado.
        </div>
      </div>
    );
  }

  if (isLow) {
    return (
      <div className="flex items-start gap-2 p-3 bg-amber-50 border border-amber-100 rounded-lg">
        <Info className="w-4 h-4 text-amber-600 flex-shrink-0 mt-0.5" />
        <div className="text-xs text-amber-800">
          A Meta recomenda <strong>{RECOMMENDED_INTERVAL_SECONDS}s ou mais</strong>{' '}
          entre mensagens de marketing para preservar a Quality Rating do número.
          Disparos rápidos demais podem aumentar bloqueios e reports.
        </div>
      </div>
    );
  }

  return (
    <div className="flex items-start gap-2 p-3 bg-emerald-50/50 border border-emerald-100 rounded-lg">
      <Info className="w-4 h-4 text-emerald-600 flex-shrink-0 mt-0.5" />
      <div className="text-xs text-emerald-800">
        Limites considerados:
        <ul className="list-disc ml-4 mt-1 space-y-0.5">
          <li>Meta Cloud API: throughput até 80 msg/s, mas marketing é melhor com 1–3s.</li>
          <li>DataCrazy: 60 req/min por rota (1s mínimo).</li>
        </ul>
      </div>
    </div>
  );
}
