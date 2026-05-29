import { Tag, Loader2, AlertCircle } from 'lucide-react';
import type { CampaignType } from '../types';

interface CampaignTypeSelectorProps {
  types: CampaignType[];
  selectedCode: string | null;
  onSelect: (code: string) => void;
  loading: boolean;
  error: string | null;
}

const CARD_COLOR: Record<string, string> = {
  FINANCEIRO: 'border-amber-200 bg-amber-50 text-amber-800',
  ACESSO_PLATAFORMA: 'border-blue-200 bg-blue-50 text-blue-800',
  PROVAS_AVALIACOES: 'border-violet-200 bg-violet-50 text-violet-800',
};

export function CampaignTypeSelector({
  types,
  selectedCode,
  onSelect,
  loading,
  error,
}: CampaignTypeSelectorProps) {
  return (
    <div className="bg-white rounded-2xl border border-gray-100 p-6 shadow-sm">
      <h2 className="text-lg font-semibold text-gray-900 mb-4 flex items-center gap-2">
        <Tag className="w-5 h-5 text-gray-500" />
        Tipo de campanha
        <span className="text-xs font-normal text-red-500">*</span>
      </h2>

      {loading && (
        <div className="flex items-center gap-2 px-3 py-3 bg-gray-50 rounded-lg text-sm text-gray-500">
          <Loader2 className="w-4 h-4 animate-spin" />
          Carregando tipos...
        </div>
      )}

      {!loading && error && (
        <div className="flex items-start gap-2 p-3 bg-red-50 border border-red-100 rounded-lg">
          <AlertCircle className="w-4 h-4 text-red-500 flex-shrink-0 mt-0.5" />
          <div>
            <p className="text-sm font-medium text-red-700">Falha ao carregar tipos</p>
            <p className="text-xs text-red-600 mt-0.5 break-words">{error}</p>
            <p className="text-xs text-red-600 mt-1">
              Verifique se o banco está configurado e migrations aplicadas.
            </p>
          </div>
        </div>
      )}

      {!loading && !error && (
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
          {types.map((t) => {
            const isSelected = selectedCode === t.code;
            const color = CARD_COLOR[t.code] || 'border-gray-200 bg-gray-50 text-gray-700';
            return (
              <button
                key={t.id}
                type="button"
                onClick={() => onSelect(t.code)}
                className={`text-left p-3 rounded-xl border-2 transition-all ${
                  isSelected
                    ? `${color} border-current/40 ring-2 ring-offset-1 ring-current/20`
                    : 'border-gray-100 bg-white hover:bg-gray-50 text-gray-700'
                }`}
              >
                <p className="text-sm font-semibold mb-0.5">{t.name}</p>
                <p
                  className={`text-[11px] leading-snug ${
                    isSelected ? 'opacity-90' : 'text-gray-400'
                  }`}
                >
                  {t.description || t.code}
                </p>
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
