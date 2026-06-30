/**
 * Rótulos e agrupamento da coluna BASE / origem_ativacao no Meu Painel.
 * Espelha src/services/meuPainelApi.ts (manter em sync).
 */

const CATEGORY_LABEL = {
  'docs-pendentes': 'Docs Pendentes',
  financeiro: 'Financeiro',
  'acessos-blackboard': 'Acessos Blackboard',
  'processos-caa': 'Processos CAA',
  'provavel-evasao': 'Provável Evasão',
  rematricula: 'Rematrícula',
};

const ORIGEM_GROUP_LABEL = {
  'processos-caa:default': 'Processos CAA',
  'processos-caa:atm': 'Processos CAA ATM',
  'processos-caa:ia': 'Processos CAA IA',
};

/** @param {string} category @param {string|null|undefined} origemAtivacao */
export function getMeuPainelOrigemGroupKey(category, origemAtivacao) {
  const cat = String(category || '').trim().toLowerCase();
  const origem = String(origemAtivacao || '').trim().toLowerCase();

  if (cat === 'processos-caa') {
    if (origem === 'caa_atm') return 'processos-caa:atm';
    if (origem === 'caa_ia') return 'processos-caa:ia';
    return 'processos-caa:default';
  }

  return cat || 'unknown';
}

/** @param {string} category @param {string|null|undefined} origemAtivacao */
export function getMeuPainelBaseLabel(category, origemAtivacao) {
  const key = getMeuPainelOrigemGroupKey(category, origemAtivacao);
  if (ORIGEM_GROUP_LABEL[key]) return ORIGEM_GROUP_LABEL[key];
  return CATEGORY_LABEL[category] || category;
}

/**
 * Agrupa linhas brutas (category + origem_ativacao) em buckets de exibição.
 * @param {Array<{ category: string, origem_ativacao?: string|null, total: number }>} rows
 * @returns {Array<{ key: string, label: string, total: number }>}
 */
export function aggregateMeuPainelOrigemCounts(rows) {
  const map = new Map();
  for (const row of rows) {
    const key = getMeuPainelOrigemGroupKey(row.category, row.origem_ativacao);
    const label = getMeuPainelBaseLabel(row.category, row.origem_ativacao);
    const total = Number(row.total || 0);
    const prev = map.get(key);
    if (prev) {
      prev.total += total;
    } else {
      map.set(key, { key, label, total });
    }
  }
  return [...map.values()].sort(
    (a, b) => b.total - a.total || a.label.localeCompare(b.label, 'pt-BR')
  );
}
