/**
 * Meu Painel — Processos CAA: só Wesley Guerreiro e Danubia atendem esta base.
 * Outros nomes vindos do DataCrazy/webhook não entram na fila de marcação.
 */

export const CAA_MEU_PAINEL_CONSULTORES = ['Wesley Guerreiro', 'Danubia'];

/**
 * @param {string|null|undefined} nome
 */
export function isCaaMeuPainelConsultorAllowed(nome) {
  const n = String(nome || '').trim().toLowerCase();
  if (!n) return false;
  return n.startsWith('wesley') || n.startsWith('danubia');
}

/**
 * SQL AND: libera linhas fora de processos-caa; em CAA exige consultor efetivo Wesley/Danubia.
 * @param {string} effectiveConsultorExpr ex.: MEU_PAINEL_EFFECTIVE_CONSULTOR_SQL (alias ar)
 */
export function sqlCaaMeuPainelConsultorAllowlist(effectiveConsultorExpr) {
  return `(
    ar.category <> 'processos-caa'
    or ${effectiveConsultorExpr} ilike 'wesley%'
    or ${effectiveConsultorExpr} ilike 'danubia%'
  )`;
}
