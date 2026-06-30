import * as journeySettingsRepo from '../repositories/journeySettingsRepository.js';

const ACTIVATION_CATEGORIES = /** @type {const} */ ([
  'docs-pendentes',
  'financeiro',
  'provavel-evasao',
  'acessos-blackboard',
  'processos-caa',
  'aguardando-inicio',
  'conteudo-previo',
  'rematricula',
]);

const CONFIG_KEY = 'activation_templates';

/** @typedef {'first'|'repeat'|'fifth'} ActivationTierKey */

function parseRawConfig(raw) {
  if (!raw) return {};
  if (typeof raw === 'string') {
    try {
      const parsed = JSON.parse(raw);
      return parsed && typeof parsed === 'object' ? { ...parsed } : {};
    } catch {
      return {};
    }
  }
  if (typeof raw === 'object') return { ...raw };
  return {};
}

/**
 * @returns {Promise<Record<string, { first?: string, repeat?: string, fifth?: string }>>}
 */
export async function getActivationTemplateConfig() {
  const global = await journeySettingsRepo.getGlobal();
  const raw = parseRawConfig(global?.raw_config);
  if (!Object.keys(raw).length) return {};
  const block = /** @type {Record<string, unknown>} */ (raw)[CONFIG_KEY];
  if (!block || typeof block !== 'object') return {};
  /** @type {Record<string, { first?: string, repeat?: string, fifth?: string }>} */
  const out = {};
  for (const cat of ACTIVATION_CATEGORIES) {
    const row = block[cat];
    if (!row || typeof row !== 'object') continue;
    const r = /** @type {Record<string, unknown>} */ (row);
    out[cat] = {
      first: r.first ? String(r.first).trim() : undefined,
      repeat: r.repeat ? String(r.repeat).trim() : undefined,
      fifth: r.fifth ? String(r.fifth).trim() : undefined,
    };
  }
  return out;
}

/**
 * @param {string} category
 * @param {{ first?: string|null, repeat?: string|null, fifth?: string|null }} patch
 */
export async function setActivationTemplateConfig(category, patch) {
  if (!ACTIVATION_CATEGORIES.includes(category)) {
    const err = new Error(`Categoria inválida: ${category}`);
    err.status = 400;
    throw err;
  }
  const global = await journeySettingsRepo.resolveForTerm(null);
  const raw = parseRawConfig(global?.raw_config);
  const current =
    raw[CONFIG_KEY] && typeof raw[CONFIG_KEY] === 'object'
      ? { .../** @type {object} */ (raw[CONFIG_KEY]) }
      : {};
  const prev =
    current[category] && typeof current[category] === 'object'
      ? { ...current[category] }
      : {};
  for (const key of ['first', 'repeat', 'fifth']) {
    if (patch[key] === undefined) continue;
    const v = patch[key];
    if (v === null || v === '') delete prev[key];
    else prev[key] = String(v).trim();
  }
  current[category] = prev;
  raw[CONFIG_KEY] = current;
  await journeySettingsRepo.upsertGlobal({ raw_config: raw });
  return getActivationTemplateConfig();
}
