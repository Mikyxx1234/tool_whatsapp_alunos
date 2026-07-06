/** Filtro de origem_ativacao (sub-tipo CAA) — compartilhado Painel / Meu Painel. */

export const PAINEL_ORIGEM_OPCOES = ['geral', 'caa', 'caa_atm', 'caa_ia'];

/**
 * @param {string|null|undefined} raw
 * @returns {'caa'|'caa_atm'|'caa_ia'|null} null = geral (sem filtro)
 */
export function normalizeOrigemAtivacaoFilter(raw) {
  const s = String(raw || '').trim().toLowerCase();
  if (!s || s === 'geral' || s === 'all' || s === '*') return null;
  if (s === 'caa' || s === 'caa_atm' || s === 'caa_ia') return s;
  return null;
}

/**
 * Fragmento SQL AND para coluna origem_ativacao.
 * @param {string} alias ex.: ar
 * @param {'caa'|'caa_atm'|'caa_ia'|null} filter
 */
export function sqlOrigemAtivacaoCond(alias, filter) {
  if (!filter) return '';
  const col = `lower(trim(coalesce(${alias}.origem_ativacao, '')))`;
  if (filter === 'caa') {
    return ` and (${col} = '' or ${col} = 'caa')`;
  }
  return ` and ${col} = '${filter}'`;
}

/** Chave do bucket por_base / meuPainelLabels quando filtro CAA ativo. */
export function origemFilterToGroupKey(filter) {
  if (!filter || filter === 'caa') return 'processos-caa:default';
  if (filter === 'caa_atm') return 'processos-caa:atm';
  if (filter === 'caa_ia') return 'processos-caa:ia';
  return null;
}

/** EXISTS: desfecho amo casa com response ar (mesma regra do Meu Painel) + origem opcional. */
export function sqlOutcomeLinkedToResponseExists(amoAlias, origemFilter) {
  const origem = sqlOrigemAtivacaoCond('ar', origemFilter);
  return `
    exists (
      select 1
        from activation_responses ar
       where ar.category = ${amoAlias}.category
         and (
           (
             nullif(trim(coalesce(ar.rgm, '')), '') is not null
             and ${amoAlias}.rgm is not null
             and regexp_replace(${amoAlias}.rgm, '[^0-9]', '', 'g')
                 = regexp_replace(coalesce(ar.rgm, ''), '[^0-9]', '', 'g')
             and length(regexp_replace(${amoAlias}.rgm, '[^0-9]', '', 'g')) >= 5
           )
           or (
             nullif(trim(coalesce(ar.master_key, '')), '') is not null
             and ${amoAlias}.master_key is not null
             and ar.master_key = ${amoAlias}.master_key
           )
         )
         ${origem}
    )
  `;
}
