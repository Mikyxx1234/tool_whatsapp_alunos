/**
 * Fonte operacional do CRM (DataCrazy vs Novo CRM) durante a migração.
 *
 * Env:
 *   NOVO_CRM_ENABLED=1
 *   NOVO_CRM_API_BASE_URL=https://cruzeiro-ead.bwipo.com
 *   NOVO_CRM_API_TOKEN=eduit_...
 *   NOVO_CRM_DATABASE_URL=postgres://...  (leitura Painel / campanhas)
 */

export const CRM_FONTES = Object.freeze(['datacrazy', 'novo_crm']);

/**
 * @param {unknown} raw
 * @returns {'datacrazy'|'novo_crm'}
 */
export function normalizeCrmFonte(raw) {
  const v = String(raw || '')
    .trim()
    .toLowerCase()
    .replace(/[-\s]+/g, '_');
  if (v === 'novo_crm' || v === 'novo' || v === 'new_crm') return 'novo_crm';
  return 'datacrazy';
}

/** Pronto pra leitura do Painel (Postgres do CRM). */
export function isNovoCrmConfigured() {
  const enabled = String(process.env.NOVO_CRM_ENABLED || '').trim() === '1';
  const hasUrl = Boolean(String(process.env.NOVO_CRM_DATABASE_URL || '').trim());
  return enabled && hasUrl;
}

/** Pronto pra escrita via API (tag no deal). */
export function isNovoCrmApiConfigured() {
  const enabled = String(process.env.NOVO_CRM_ENABLED || '').trim() === '1';
  const hasToken = Boolean(String(process.env.NOVO_CRM_API_TOKEN || '').trim());
  return enabled && hasToken;
}

/**
 * @param {'datacrazy'|'novo_crm'} fonte
 * @returns {{ ok: true } | { ok: false, status: number, error: string }}
 */
export function assertCrmFonteReady(fonte) {
  const f = normalizeCrmFonte(fonte);
  if (f === 'datacrazy') return { ok: true };
  if (isNovoCrmConfigured() || isNovoCrmApiConfigured()) return { ok: true };
  return {
    ok: false,
    status: 503,
    error:
      'Novo CRM selecionado, mas ainda não configurado. Defina NOVO_CRM_ENABLED=1 e NOVO_CRM_API_TOKEN / NOVO_CRM_DATABASE_URL.',
  };
}
