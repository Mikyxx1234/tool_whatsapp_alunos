import { useCallback, useEffect, useState } from 'react';
import {
  CRM_FONTE_OPTIONS,
  type CrmFonte,
  readCrmFonte,
  storeCrmFonte,
} from '../services/crmFonte';

export const CRM_FONTE_CHANGED_EVENT = 'crm_fonte_changed';

/** Preferência global DataCrazy ↔ Novo CRM (localStorage + evento). */
export function useCrmFonte(): [CrmFonte, (id: CrmFonte) => void] {
  const [fonte, setFonte] = useState<CrmFonte>(() => readCrmFonte());

  useEffect(() => {
    const sync = () => setFonte(readCrmFonte());
    const onCustom = (e: Event) => {
      const detail = (e as CustomEvent<CrmFonte>).detail;
      if (detail) setFonte(detail);
      else sync();
    };
    window.addEventListener('storage', sync);
    window.addEventListener(CRM_FONTE_CHANGED_EVENT, onCustom);
    return () => {
      window.removeEventListener('storage', sync);
      window.removeEventListener(CRM_FONTE_CHANGED_EVENT, onCustom);
    };
  }, []);

  const setCrmFonte = useCallback((id: CrmFonte) => {
    storeCrmFonte(id);
    setFonte(id);
    window.dispatchEvent(new CustomEvent(CRM_FONTE_CHANGED_EVENT, { detail: id }));
  }, []);

  return [fonte, setCrmFonte];
}

interface CrmFonteToggleProps {
  className?: string;
  /** compact = só no header */
  size?: 'sm' | 'md';
}

/**
 * Alterna DataCrazy ↔ Novo CRM sem desligar nenhum dos dois no servidor.
 * Só muda a fonte operacional desta sessão (localStorage).
 */
export function CrmFonteToggle({ className = '', size = 'sm' }: CrmFonteToggleProps) {
  const [fonte, setCrmFonte] = useCrmFonte();
  const pad = size === 'md' ? 'px-3 py-1.5' : 'px-2.5 py-1';

  return (
    <div
      className={`inline-flex rounded-lg border border-sky-200 bg-sky-50/80 p-0.5 ${className}`}
      title="Fonte operacional — DataCrazy (WhatsApp) ou Novo CRM (tag). Não desliga o outro fluxo."
    >
      {CRM_FONTE_OPTIONS.map((opt) => (
        <button
          key={opt.id}
          type="button"
          title={opt.hint}
          onClick={() => setCrmFonte(opt.id)}
          className={`${pad} text-[11px] font-semibold rounded-md transition-colors ${
            fonte === opt.id
              ? 'bg-sky-600 text-white shadow-sm'
              : 'text-sky-800/80 hover:bg-white/70'
          }`}
        >
          {opt.label}
        </button>
      ))}
    </div>
  );
}
