import { CheckCircle2, AlertCircle, Calendar } from 'lucide-react';

export interface JourneySummaryData {
  imported: number;
  updated: number;
  total: number;
  fluxoCounts: { A: number; B: number; C: number; INDEFINIDO: number };
  totalEventsGenerated: number;
  errors: Array<{ index?: number; studentId?: string; error: string }>;
}

const FLOW_CARDS: Array<{
  key: keyof JourneySummaryData['fluxoCounts'];
  title: string;
  description: string;
  badgeClass: string;
}> = [
  {
    key: 'A',
    title: 'Fluxo A',
    description: 'Ativação imediata (GAP ≤ 2)',
    badgeClass: 'bg-emerald-50 text-emerald-700 border-emerald-200',
  },
  {
    key: 'B',
    title: 'Fluxo B',
    description: 'Espera curta (3 a 30 dias)',
    badgeClass: 'bg-amber-50 text-amber-700 border-amber-200',
  },
  {
    key: 'C',
    title: 'Fluxo C',
    description: 'Espera longa (>30 dias)',
    badgeClass: 'bg-sky-50 text-sky-700 border-sky-200',
  },
  {
    key: 'INDEFINIDO',
    title: 'Indefinido',
    description: 'Sem datas suficientes',
    badgeClass: 'bg-gray-50 text-gray-600 border-gray-200',
  },
];

interface JourneySummaryProps {
  data: JourneySummaryData;
}

export function JourneySummary({ data }: JourneySummaryProps) {
  return (
    <div className="bg-white rounded-2xl border border-gray-100 shadow-sm p-4 sm:p-6 space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h3 className="text-base font-semibold text-gray-900">
            Importação concluída
          </h3>
          <p className="text-xs text-gray-500 mt-0.5">
            {data.imported} criado(s), {data.updated} atualizado(s) — total {data.total}.
          </p>
        </div>
        <div className="flex items-center gap-2 text-sm text-emerald-700 font-medium">
          <CheckCircle2 className="w-4 h-4" />
          <span>{data.total} aluno(s)</span>
        </div>
      </div>

      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        {FLOW_CARDS.map((card) => (
          <div
            key={card.key}
            className={`rounded-xl border p-4 ${card.badgeClass}`}
          >
            <p className="text-xs uppercase tracking-wide font-medium opacity-80">
              {card.title}
            </p>
            <p className="text-2xl font-semibold mt-1">
              {data.fluxoCounts[card.key] || 0}
            </p>
            <p className="text-xs mt-1 opacity-80">{card.description}</p>
          </div>
        ))}
      </div>

      <div className="border-t border-gray-100 pt-4 grid grid-cols-1 md:grid-cols-2 gap-3">
        <div className="flex items-center gap-3 p-3 rounded-lg bg-whatsapp-50/50 border border-whatsapp-100">
          <div className="w-9 h-9 bg-whatsapp-500 text-white rounded-lg flex items-center justify-center">
            <Calendar className="w-4 h-4" />
          </div>
          <div>
            <p className="text-xs text-gray-500">Eventos agendados</p>
            <p className="text-lg font-semibold text-gray-900">
              {data.totalEventsGenerated}
            </p>
          </div>
        </div>
        <div
          className={`flex items-center gap-3 p-3 rounded-lg border ${
            data.errors.length > 0
              ? 'bg-rose-50/60 border-rose-200'
              : 'bg-gray-50 border-gray-100'
          }`}
        >
          <div
            className={`w-9 h-9 rounded-lg flex items-center justify-center ${
              data.errors.length > 0
                ? 'bg-rose-500 text-white'
                : 'bg-gray-200 text-gray-600'
            }`}
          >
            <AlertCircle className="w-4 h-4" />
          </div>
          <div>
            <p className="text-xs text-gray-500">Erros na importação</p>
            <p className="text-lg font-semibold text-gray-900">
              {data.errors.length}
            </p>
          </div>
        </div>
      </div>

      {data.errors.length > 0 && (
        <details className="text-xs text-rose-700">
          <summary className="cursor-pointer font-medium">Ver erros</summary>
          <ul className="mt-2 space-y-1 list-disc list-inside">
            {data.errors.slice(0, 30).map((e, idx) => (
              <li key={idx}>
                {e.studentId ? `[${e.studentId}] ` : ''}
                {e.error}
              </li>
            ))}
          </ul>
        </details>
      )}
    </div>
  );
}
