/**
 * Unifica variantes do mesmo consultor (ex.: "Danubia" vs "Danubia Sousa").
 * Espelha a lógica de alias do dcz (meus_atendimentos.CONSULTOR_ALIASES).
 */

function stripAccents(s) {
  return String(s || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '');
}

/** @param {string|null|undefined} n */
export function normConsultorNome(n) {
  return stripAccents(String(n || '').trim().toLowerCase()).replace(/\s+/g, ' ');
}

/**
 * @param {string} a
 * @param {string} b
 */
export function consultorNomesMatch(a, b) {
  const na = normConsultorNome(a);
  const nb = normConsultorNome(b);
  if (!na || !nb) return false;
  if (na === nb) return true;
  if (na.startsWith(`${nb} `) || nb.startsWith(`${na} `)) return true;
  const ta = na.split(' ');
  const tb = nb.split(' ');
  if (ta[0] && ta[0] === tb[0] && (ta.length === 1 || tb.length === 1)) return true;
  return false;
}

/**
 * @param {string[]} nomes
 * @param {Array<{ nome?: string }>} [catalogo]
 */
export function pickCanonicalConsultorNome(nomes, catalogo = []) {
  const list = nomes.filter(Boolean);
  if (!list.length) return '';

  for (const item of catalogo) {
    const cn = String(item?.nome || '').trim();
    if (!cn) continue;
    for (const n of list) {
      if (consultorNomesMatch(n, cn)) return cn;
    }
  }

  return [...list].sort((a, b) => b.length - a.length || a.localeCompare(b, 'pt-BR'))[0];
}

/**
 * @param {string[]} allNames
 * @param {Array<{ nome?: string, username?: string }>} [catalogo]
 */
export function buildConsultorResolver(allNames, catalogo = []) {
  const names = [...new Set(allNames.map((n) => String(n || '').trim()).filter(Boolean))];
  const parent = new Map();

  /** @param {string} x */
  function find(x) {
    if (!parent.has(x)) parent.set(x, x);
    const p = parent.get(x);
    if (p !== x) {
      const root = find(p);
      parent.set(x, root);
      return root;
    }
    return x;
  }

  /** @param {string} a @param {string} b */
  function union(a, b) {
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent.set(ra, rb);
  }

  for (let i = 0; i < names.length; i += 1) {
    for (let j = i + 1; j < names.length; j += 1) {
      if (consultorNomesMatch(names[i], names[j])) union(names[i], names[j]);
    }
  }

  const groups = new Map();
  for (const n of names) {
    const root = find(n);
    if (!groups.has(root)) groups.set(root, []);
    groups.get(root).push(n);
  }

  /** norm(raw) -> norm(canonical display) */
  const toKey = new Map();
  /** norm(canonical) -> display canonical */
  const displayByKey = new Map();

  for (const groupNames of groups.values()) {
    const canonical = pickCanonicalConsultorNome(groupNames, catalogo);
    const key = normConsultorNome(canonical);
    displayByKey.set(key, canonical);
    for (const n of groupNames) {
      toKey.set(normConsultorNome(n), key);
    }
  }

  return {
    /** @param {string|null|undefined} nome */
    resolveKey(nome) {
      const raw = normConsultorNome(nome);
      if (!raw) return '';
      return toKey.get(raw) || raw;
    },
    /** @param {string} keyOrNome */
    displayName(keyOrNome) {
      const key = normConsultorNome(keyOrNome);
      return displayByKey.get(key) || String(keyOrNome || '').trim();
    },
    keys() {
      return [...displayByKey.keys()];
    },
  };
}
