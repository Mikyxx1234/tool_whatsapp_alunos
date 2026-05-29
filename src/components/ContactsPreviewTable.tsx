import { Search, Filter } from 'lucide-react';
import { useMemo, useState } from 'react';
import type { Contact, ContactStatus } from '../types';
import { formatPhoneForDisplay } from '../utils/phoneNormalizer';

const statusConfig: Record<ContactStatus, { label: string; class: string }> = {
  valid: { label: 'Válido', class: 'bg-emerald-50 text-emerald-700 border-emerald-200' },
  invalid: { label: 'Inválido', class: 'bg-red-50 text-red-700 border-red-200' },
  duplicate: { label: 'Duplicado', class: 'bg-amber-50 text-amber-700 border-amber-200' },
  pending: { label: 'Pendente', class: 'bg-gray-50 text-gray-700 border-gray-200' },
  sending: { label: 'Enviando...', class: 'bg-blue-50 text-blue-700 border-blue-200' },
  sent: { label: 'Enviado', class: 'bg-emerald-50 text-emerald-700 border-emerald-200' },
  error: { label: 'Erro', class: 'bg-red-50 text-red-700 border-red-200' },
};

type FilterValue = 'all' | ContactStatus;

interface ContactsPreviewTableProps {
  contacts: Contact[];
}

export function ContactsPreviewTable({ contacts }: ContactsPreviewTableProps) {
  const [filter, setFilter] = useState<FilterValue>('all');
  const [search, setSearch] = useState('');

  const filtered = useMemo(() => {
    return contacts.filter((c) => {
      if (filter !== 'all' && c.status !== filter) return false;
      if (search) {
        const haystack = `${c.name || ''} ${c.phone} ${c.rawPhone} ${c.email || ''}`.toLowerCase();
        if (!haystack.includes(search.toLowerCase())) return false;
      }
      return true;
    });
  }, [contacts, filter, search]);

  return (
    <div className="bg-white rounded-2xl border border-gray-100 p-6 shadow-sm">
      <h2 className="text-lg font-semibold text-gray-900 mb-4">
        Prévia da base
        <span className="ml-2 text-xs font-normal text-gray-400">
          ({filtered.length} de {contacts.length})
        </span>
      </h2>
      <div className="flex flex-col sm:flex-row gap-3 mb-4">
        <div className="relative flex-1">
          <Search className="w-4 h-4 text-gray-400 absolute left-3 top-1/2 -translate-y-1/2" />
          <input
            type="text"
            placeholder="Buscar por nome, telefone ou email..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="w-full pl-9 pr-3 py-2 text-sm border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-whatsapp-500/20 focus:border-whatsapp-500"
          />
        </div>
        <div className="relative">
          <Filter className="w-4 h-4 text-gray-400 absolute left-3 top-1/2 -translate-y-1/2" />
          <select
            value={filter}
            onChange={(e) => setFilter(e.target.value as FilterValue)}
            className="pl-9 pr-8 py-2 text-sm border border-gray-200 rounded-lg appearance-none bg-white focus:outline-none focus:ring-2 focus:ring-whatsapp-500/20 focus:border-whatsapp-500"
          >
            <option value="all">Todos</option>
            <option value="valid">Válidos</option>
            <option value="invalid">Inválidos</option>
            <option value="duplicate">Duplicados</option>
            <option value="pending">Pendentes</option>
            <option value="sending">Enviando</option>
            <option value="sent">Enviados</option>
            <option value="error">Com erro</option>
          </select>
        </div>
      </div>
      <div className="overflow-x-auto rounded-xl border border-gray-100 max-h-[420px] overflow-y-auto">
        <table className="w-full text-sm">
          <thead className="sticky top-0 z-10">
            <tr className="bg-gray-50">
              <th className="text-left py-3 px-4 font-medium text-gray-500">Nome</th>
              <th className="text-left py-3 px-4 font-medium text-gray-500">Telefone</th>
              <th className="text-left py-3 px-4 font-medium text-gray-500">Status</th>
              <th className="text-left py-3 px-4 font-medium text-gray-500">Detalhe</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-50">
            {filtered.length === 0 ? (
              <tr>
                <td colSpan={4} className="py-6 px-4 text-center text-gray-400 text-sm">
                  Nenhum contato encontrado.
                </td>
              </tr>
            ) : (
              filtered.map((contact) => (
                <tr key={contact.id} className="hover:bg-gray-50/50 transition-colors">
                  <td className="py-3 px-4 text-gray-900">{contact.name || '—'}</td>
                  <td className="py-3 px-4 text-gray-600 font-mono text-xs">
                    {contact.phone ? formatPhoneForDisplay(contact.phone) : contact.rawPhone || '—'}
                  </td>
                  <td className="py-3 px-4">
                    <span
                      className={`inline-flex items-center px-2 py-0.5 rounded-md text-xs font-medium border ${statusConfig[contact.status].class}`}
                    >
                      {statusConfig[contact.status].label}
                    </span>
                  </td>
                  <td className="py-3 px-4 text-gray-500 text-xs max-w-[260px] truncate" title={contact.errorMessage || contact.messageId}>
                    {contact.errorMessage || contact.messageId || '—'}
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
