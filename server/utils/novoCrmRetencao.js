/**
 * Tabulações de retenção no CRM (conversation_close_tabulations).
 * v1: question ≈ "Retido?" → answer Sim|Não.
 */

/** @returns {string} */
export function retencaoQuestionPattern() {
  const raw = String(process.env.NOVO_CRM_RETENCAO_QUESTION || 'Retido?').trim();
  return raw || 'Retido?';
}

/**
 * Normaliza pergunta pra comparação (lowercase, sem espaços extras, ? opcional).
 * @param {unknown} q
 */
export function normalizeTabulationQuestion(q) {
  return String(q || '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .replace(/\?+$/g, '?');
}

/**
 * @param {unknown} question
 * @returns {boolean}
 */
export function isRetencaoQuestion(question) {
  const want = normalizeTabulationQuestion(retencaoQuestionPattern());
  const got = normalizeTabulationQuestion(question);
  if (!got) return false;
  const wantCore = want.replace(/\?+$/g, '').trim();
  const gotCore = got.replace(/\?+$/g, '').trim();
  return got === want || gotCore === wantCore;
}

/**
 * @param {unknown} answer
 * @returns {'retido'|'nao_retido'|null}
 */
export function retentionOutcomeFromAnswer(answer) {
  const a = String(answer || '')
    .trim()
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '');
  if (a === 'sim' || a === 's' || a === 'yes' || a === 'true' || a === '1') return 'retido';
  if (a === 'nao' || a === 'não' || a === 'n' || a === 'no' || a === 'false' || a === '0') {
    return 'nao_retido';
  }
  return null;
}

/**
 * Mapeia retenção → outcome legado (UI/compat API).
 * @param {'retido'|'nao_retido'|null|undefined} retention
 * @returns {'revertido'|'confirmado'|null}
 */
export function retentionToLegacyOutcome(retention) {
  if (retention === 'retido') return 'revertido';
  if (retention === 'nao_retido') return 'confirmado';
  return null;
}
