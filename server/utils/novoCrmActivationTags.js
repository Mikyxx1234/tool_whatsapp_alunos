/**
 * Tags de ativação no Novo CRM (EduIT) — aplicadas no **deal (lead)**.
 * Naming estável pra automação/segmento; não altera o envio WhatsApp atual.
 */

/** @type {Readonly<Record<string, string>>} */
export const ATIVACAO_TAG_BY_CATEGORY = Object.freeze({
  'processos-caa': 'ativacao-caa',
  financeiro: 'ativacao-financeiro',
  'docs-pendentes': 'ativacao-docs',
  'acessos-blackboard': 'ativacao-blackboard',
  'provavel-evasao': 'ativacao-evasao',
  rematricula: 'ativacao-rematricula',
  'aguardando-inicio': 'ativacao-aguardando-inicio',
  'conteudo-previo': 'ativacao-conteudo-previo',
});

/**
 * @param {string} category
 * @returns {string|null}
 */
export function tagNameForCategory(category) {
  const key = String(category || '').trim();
  return ATIVACAO_TAG_BY_CATEGORY[key] || null;
}
