/**
 * Helpers compartilhados pelos scripts DEV-only do Novo CRM.
 * Token NUNCA vem hardcoded — só de env (preferir NOVO_CRM_DEV_API_TOKEN).
 */

export const DEV_CRM_HOST = 'crm-dev-frontend.ca31ey.easypanel.host';
export const DEV_CRM_BASE_URL = `https://${DEV_CRM_HOST}`;

/**
 * Força URL DEV + token via env. Aborta se faltar token ou se apontar pra prod.
 * @param {{ requireToken?: boolean }} [opts]
 */
export function forceNovoCrmDevEnv(opts = {}) {
  const requireToken = opts.requireToken !== false;

  process.env.NOVO_CRM_ENABLED = '1';
  process.env.NOVO_CRM_API_BASE_URL =
    String(process.env.NOVO_CRM_DEV_API_BASE_URL || '').trim() || DEV_CRM_BASE_URL;

  const token = String(
    process.env.NOVO_CRM_DEV_API_TOKEN || process.env.NOVO_CRM_API_TOKEN || ''
  ).trim();
  if (requireToken && !token) {
    console.error(
      '[novo-crm-dev] ABORTADO: defina NOVO_CRM_DEV_API_TOKEN (ou NOVO_CRM_API_TOKEN) no .env.'
    );
    process.exit(2);
  }
  if (token) process.env.NOVO_CRM_API_TOKEN = token;

  const base = String(process.env.NOVO_CRM_API_BASE_URL || '');
  let host = '';
  try {
    host = new URL(base).host.toLowerCase();
  } catch {
    host = base.toLowerCase();
  }
  if (
    host === 'crm.eduit.com.br' ||
    host.endsWith('.crm.eduit.com.br') ||
    host === 'cruzeiro-ead.bwipo.com'
  ) {
    console.error('[novo-crm-dev] ABORTADO: base aponta pra PRODUÇÃO. DEV-only.');
    process.exit(2);
  }
  if (host !== DEV_CRM_HOST && !host.includes('localhost') && !host.includes('127.0.0.1')) {
    const allowExtra = String(process.env.NOVO_CRM_PROVISION_ALLOW_DEV_HOSTS || '').trim() === '1';
    if (!(allowExtra && (host.includes('crm-dev') || host.startsWith('crm-dev.')))) {
      console.error(
        `[novo-crm-dev] ABORTADO: host inesperado (${host}). Esperado ${DEV_CRM_HOST}.`
      );
      process.exit(2);
    }
  }

  return { base: process.env.NOVO_CRM_API_BASE_URL, host };
}
