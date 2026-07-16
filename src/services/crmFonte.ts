/**
 * Fonte operacional do CRM durante a migração DataCrazy → Novo CRM.
 * Preferência global (localStorage): Painel, Meu Painel e marcações leem daqui.
 */

export type CrmFonte = 'datacrazy' | 'novo_crm';

export const CRM_FONTE_STORAGE = 'crm_fonte_v1';

export const CRM_FONTE_OPTIONS: Array<{ id: CrmFonte; label: string; hint: string }> = [
  {
    id: 'datacrazy',
    label: 'DataCrazy',
    hint: 'Fonte atual — histórico e webhooks DataCrazy',
  },
  {
    id: 'novo_crm',
    label: 'Novo CRM',
    hint: 'Migração — novos webhooks e marcações no CRM novo',
  },
];

export function normalizeCrmFonte(raw: unknown): CrmFonte {
  const v = String(raw || '')
    .trim()
    .toLowerCase()
    .replace(/[-\s]+/g, '_');
  if (v === 'novo_crm' || v === 'novo' || v === 'new_crm') return 'novo_crm';
  return 'datacrazy';
}

export function readCrmFonte(): CrmFonte {
  try {
    return normalizeCrmFonte(localStorage.getItem(CRM_FONTE_STORAGE));
  } catch {
    return 'datacrazy';
  }
}

export function storeCrmFonte(id: CrmFonte): void {
  try {
    localStorage.setItem(CRM_FONTE_STORAGE, normalizeCrmFonte(id));
  } catch {
    /* ignore */
  }
}

export function crmFonteLabel(id: CrmFonte): string {
  return CRM_FONTE_OPTIONS.find((o) => o.id === id)?.label ?? id;
}

export function isNovoCrm(id: CrmFonte = readCrmFonte()): boolean {
  return id === 'novo_crm';
}
