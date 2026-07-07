/**
 * Meu Painel — Processos CAA: só Wesley Guerreiro e Danubia são consultores válidos.
 * Outros nomes ficam em branco na UI até sync/backfill gravar Wesley ou Danubia.
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
 * Persistência: em processos-caa só grava Wesley/Danubia; demais categorias passam direto.
 * @param {string|null|undefined} category
 * @param {string|null|undefined} nome
 * @returns {string|null}
 */
export function sanitizeCaaConsultorForStorage(category, nome) {
  const clean =
    typeof nome === 'string' && nome.trim() ? nome.trim().slice(0, 200) : null;
  if (!clean) return null;
  if (category === 'processos-caa' && !isCaaMeuPainelConsultorAllowed(clean)) {
    return null;
  }
  return clean;
}

/**
 * SQL: consultor exibido no Meu Painel — CAA com nome inválido vira NULL.
 * @param {string} effectiveConsultorExpr ex.: MEU_PAINEL_EFFECTIVE_CONSULTOR_SQL (alias ar)
 */
export function sqlCaaMeuPainelDisplayConsultor(effectiveConsultorExpr) {
  return `case
    when ar.category = 'processos-caa'
     and not (
       ${effectiveConsultorExpr} ilike 'wesley%'
       or ${effectiveConsultorExpr} ilike 'danubia%'
     )
    then null
    else ${effectiveConsultorExpr}
  end`;
}

/**
 * SQL AND: consultor efetivo é Wesley/Danubia (ou categoria ≠ CAA).
 * @param {string} effectiveConsultorExpr
 */
export function sqlCaaConsultorAllowedCond(effectiveConsultorExpr) {
  return `(
    ar.category <> 'processos-caa'
    or ${effectiveConsultorExpr} ilike 'wesley%'
    or ${effectiveConsultorExpr} ilike 'danubia%'
  )`;
}
