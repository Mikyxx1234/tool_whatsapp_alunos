import { Check } from 'lucide-react';
import type { WhatsAppTemplate } from '../types';
import { applyVariables, getTemplateBodyText } from '../utils/templateVariables';

interface WhatsAppPreviewProps {
  template?: WhatsAppTemplate | null;
  sampleVariables?: Record<string, string>;
}

const FALLBACK_VARIABLES: Record<string, string> = {
  nome: 'João',
  curso: 'Administração',
  email: 'joao@email.com',
  origem: 'Landing Page',
};

export function WhatsAppPreview({ template, sampleVariables }: WhatsAppPreviewProps) {
  const variables = { ...FALLBACK_VARIABLES, ...(sampleVariables || {}) };

  const baseText = template
    ? getTemplateBodyText(template) || 'Template sem corpo de texto detectável.'
    : 'Selecione um template aprovado para visualizar a mensagem.';

  const previewMessage = applyVariables(baseText, variables);

  return (
    <div className="bg-white rounded-2xl border border-gray-100 p-6 shadow-sm">
      <div className="flex items-center justify-between mb-4">
        <h2 className="text-lg font-semibold text-gray-900">Preview da mensagem</h2>
        {template && (
          <span className="text-[10px] uppercase tracking-wide text-emerald-600 bg-emerald-50 px-2 py-0.5 rounded-md border border-emerald-100">
            Template: {template.name}
          </span>
        )}
      </div>
      <div className="bg-[#efeae2] rounded-xl p-4 min-h-[200px] relative overflow-hidden">
        <div
          className="absolute inset-0 opacity-[0.04]"
          style={{
            backgroundImage: `url("data:image/svg+xml,%3Csvg width='60' height='60' viewBox='0 0 60 60' xmlns='http://www.w3.org/2000/svg'%3E%3Cg fill='none' fill-rule='evenodd'%3E%3Cg fill='%23000000' fill-opacity='1'%3E%3Cpath d='M36 34v-4h-2v4h-4v2h4v4h2v-4h4v-2h-4zm0-30V0h-2v4h-4v2h4v4h2V6h4V4h-4zM6 34v-4H4v4H0v2h4v4h2v-4h4v-2H6zM6 4V0H4v4H0v2h4v4h2V6h4V4H6z'/%3E%3C/g%3E%3C/g%3E%3C/svg%3E")`,
          }}
        />
        <div className="relative flex flex-col items-end gap-1">
          <div className="max-w-[85%] bg-[#d9fdd3] rounded-lg rounded-tr-none px-3 py-2 shadow-sm">
            <p className="text-sm text-gray-800 whitespace-pre-wrap leading-relaxed">
              {previewMessage}
            </p>
            <div className="flex items-center justify-end gap-1 mt-1">
              <span className="text-[10px] text-gray-500">12:30</span>
              <Check className="w-3.5 h-3.5 text-blue-500" />
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
