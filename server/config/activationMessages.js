/**
 * Templates por categoria e “tier” de ativação (quantas vezes já ativou na mesma categoria).
 * Defina no .env, ex.:
 *   ACTIVATION_TEMPLATE_DOCS_PENDENTES_FIRST=boas_vindas_docs
 *   ACTIVATION_TEMPLATE_DOCS_PENDENTES_FIFTH=lembrete_docs_5
 */

const CATEGORY_ENV = {
  'docs-pendentes': 'DOCS_PENDENTES',
  financeiro: 'FINANCEIRO',
  'provavel-evasao': 'PROVAVEL_EVASAO',
  'acessos-blackboard': 'ACESSOS_BLACKBOARD',
  'processos-caa': 'PROCESSOS_CAA',
  rematricula: 'REMATRICULA',
};

/**
 * @param {number} priorCount — quantas ativações com sucesso já existem nesta categoria
 */
export function resolveMessageTier(priorCount) {
  const n = Math.max(0, Number(priorCount) || 0);
  if (n === 0) return 'first';
  if (n >= 4) return 'fifth';
  return 'repeat';
}

/**
 * @param {string} category
 * @param {number} priorCount
 * @param {Record<string, { first?: string, repeat?: string, fifth?: string }>|null} [storedByCategory]
 */
export function resolveTemplateForActivation(category, priorCount, storedByCategory = null) {
  const tier = resolveMessageTier(priorCount);
  const tierKey = tier === 'first' ? 'first' : tier === 'fifth' ? 'fifth' : 'repeat';
  const fromUi = storedByCategory?.[category]?.[tierKey];
  if (fromUi && String(fromUi).trim()) return String(fromUi).trim();

  const slug = CATEGORY_ENV[category];
  if (!slug) return null;

  const envTierKey = tier === 'first' ? 'FIRST' : tier === 'fifth' ? 'FIFTH' : 'REPEAT';
  const fromEnv = process.env[`ACTIVATION_TEMPLATE_${slug}_${envTierKey}`];
  if (fromEnv) return fromEnv.trim();

  const fallback = process.env[`ACTIVATION_TEMPLATE_${slug}`];
  return fallback ? fallback.trim() : null;
}

export function tierLabel(tier) {
  if (tier === 'first') return '1ª ativação';
  if (tier === 'fifth') return '5ª ativação';
  return 'Reativação';
}
