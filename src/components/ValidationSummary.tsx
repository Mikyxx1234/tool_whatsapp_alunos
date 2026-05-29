import { Users, CheckCircle, XCircle, Copy, ShieldAlert } from 'lucide-react';

interface ValidationData {
  total: number;
  valid: number;
  invalid: number;
  duplicates: number;
}

interface ValidationSummaryProps {
  data: ValidationData;
  isValidating: boolean;
}

export function ValidationSummary({ data, isValidating }: ValidationSummaryProps) {
  const stats = [
    { label: 'Total de contatos', value: data.total, icon: Users, color: 'bg-blue-50 text-blue-600' },
    { label: 'Telefones válidos', value: data.valid, icon: CheckCircle, color: 'bg-emerald-50 text-emerald-600' },
    { label: 'Telefones inválidos', value: data.invalid, icon: XCircle, color: 'bg-red-50 text-red-600' },
    { label: 'Duplicados', value: data.duplicates, icon: Copy, color: 'bg-amber-50 text-amber-600' },
  ];

  const progress = isValidating ? 60 : 100;

  return (
    <div className="bg-white rounded-2xl border border-gray-100 p-6 shadow-sm">
      <h2 className="text-lg font-semibold text-gray-900 mb-4">Validação dos contatos</h2>
      <div className="grid grid-cols-2 gap-3 mb-4">
        {stats.map((stat) => (
          <div key={stat.label} className="p-3 rounded-xl border border-gray-100 bg-gray-50/50">
            <div className={`w-8 h-8 rounded-lg flex items-center justify-center mb-2 ${stat.color.split(' ')[0]}`}>
              <stat.icon className={`w-4 h-4 ${stat.color.split(' ')[1]}`} />
            </div>
            <p className="text-xl font-semibold text-gray-900">{stat.value}</p>
            <p className="text-xs text-gray-500">{stat.label}</p>
          </div>
        ))}
      </div>
      <div className="mb-3">
        <div className="flex justify-between text-xs text-gray-500 mb-1">
          <span>{isValidating ? 'Lendo CSV...' : 'Validação concluída'}</span>
          <span>{progress}%</span>
        </div>
        <div className="w-full h-2 bg-gray-100 rounded-full overflow-hidden">
          <div
            className="h-full bg-whatsapp-500 rounded-full transition-all duration-1000"
            style={{ width: `${progress}%` }}
          />
        </div>
      </div>
      <div className="flex items-start gap-2 p-3 bg-amber-50 border border-amber-100 rounded-lg">
        <ShieldAlert className="w-4 h-4 text-amber-600 flex-shrink-0 mt-0.5" />
        <p className="text-xs text-amber-800 leading-snug">
          Confira se sua base possui consentimento para receber mensagens. Duplicados incluem
          telefone repetido no CSV e quem já recebeu o <strong>mesmo template</strong> em campanha
          anterior — outro template para a mesma pessoa é permitido.
        </p>
      </div>
    </div>
  );
}
