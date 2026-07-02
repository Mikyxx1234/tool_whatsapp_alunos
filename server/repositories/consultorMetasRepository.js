import { query } from '../db/client.js';
import { buildConsultorResolver, pickCanonicalConsultorNome } from '../utils/consultorNomeResolver.js';
import { fetchConsultoresCatalogo } from '../utils/fetchConsultoresCatalogo.js';

function normNome(n) {
  return String(n || '').trim();
}

function normAnoMes(v) {
  const s = String(v || '').trim();
  if (!/^\d{4}-\d{2}$/.test(s)) {
    const err = new Error('ano_mes inválido (use YYYY-MM)');
    err.status = 400;
    throw err;
  }
  return s;
}

/**
 * @param {{ ano_mes?: string|null }} [filters]
 */
export async function listMetas(filters = {}) {
  const anoMes = filters.ano_mes ? normAnoMes(filters.ano_mes) : null;
  const params = [];
  let where = '';
  if (anoMes) {
    params.push(anoMes);
    where = 'where ano_mes = $1';
  }
  const { rows } = await query(
    `select id, consultor_nome, ano_mes, meta_marcados, created_at, updated_at
       from consultor_metas
      ${where}
      order by ano_mes desc, lower(consultor_nome)`,
    params
  );
  return rows.map((r) => ({
    id: r.id,
    consultor_nome: r.consultor_nome,
    ano_mes: r.ano_mes,
    meta_marcados: Number(r.meta_marcados) || 0,
    created_at: r.created_at,
    updated_at: r.updated_at,
  }));
}

/**
 * @param {{ consultor_nome: string, ano_mes: string, meta_marcados: number }} payload
 */
export async function upsertMeta(payload) {
  const nomeRaw = normNome(payload.consultor_nome);
  if (!nomeRaw) {
    const err = new Error('consultor_nome é obrigatório');
    err.status = 400;
    throw err;
  }
  const catalogo = await fetchConsultoresCatalogo(payload.catalogo);
  const nome = catalogo.length
    ? pickCanonicalConsultorNome([nomeRaw], catalogo)
    : nomeRaw;
  const anoMes = normAnoMes(payload.ano_mes);
  const meta = Math.max(0, Math.floor(Number(payload.meta_marcados) || 0));

  const { rows } = await query(
    `insert into consultor_metas (consultor_nome, ano_mes, meta_marcados)
     values ($1, $2, $3)
     on conflict (consultor_nome, ano_mes)
     do update set
       meta_marcados = excluded.meta_marcados,
       updated_at = now()
     returning id, consultor_nome, ano_mes, meta_marcados, created_at, updated_at`,
    [nome, anoMes, meta]
  );
  const r = rows[0];
  return {
    id: r.id,
    consultor_nome: r.consultor_nome,
    ano_mes: r.ano_mes,
    meta_marcados: Number(r.meta_marcados) || 0,
    created_at: r.created_at,
    updated_at: r.updated_at,
  };
}

/** @param {string} id */
export async function deleteMeta(id) {
  const { rowCount } = await query(`delete from consultor_metas where id = $1`, [id]);
  return rowCount > 0;
}

/** @param {string} anoMes */
export async function metasMapForMonth(anoMes) {
  const am = normAnoMes(anoMes);
  const { rows } = await query(
    `select consultor_nome, meta_marcados
       from consultor_metas
      where ano_mes = $1`,
    [am]
  );
  const map = new Map();
  for (const r of rows) {
    map.set(String(r.consultor_nome).trim().toLowerCase(), Number(r.meta_marcados) || 0);
  }
  return map;
}

/**
 * Catálogo unificado para seleção de metas: CRM (externo) + nomes já vistos no banco.
 * @param {{ ano_mes: string, catalogo?: Array<{username?: string, nome: string}> }} opts
 */
export async function listConsultoresCatalogo(opts) {
  const anoMes = normAnoMes(opts.ano_mes);
  const catalogo = Array.isArray(opts.catalogo) ? opts.catalogo : [];

  const { rows: dbRows } = await query(
    `select nome from (
       select distinct trim(nome) as nome from (
         select consultor_responsavel_nome as nome
           from activation_responses
          where consultor_responsavel_nome is not null
            and trim(consultor_responsavel_nome) <> ''
         union
         select consultor_nome as nome
           from activation_manual_outcomes
          where consultor_nome is not null
            and trim(consultor_nome) <> ''
       ) raw
     ) dedup
     order by lower(nome)`
  );

  let externos = catalogo;
  const dczUrl = String(process.env.DCZ_CONSULTORES_URL || '').trim();
  if (!externos.length && dczUrl) {
    externos = await fetchConsultoresCatalogo();
  }

  const metas = await listMetas({ ano_mes: anoMes });

  const rawEntries = [];

  for (const item of externos) {
    const nome = normNome(item?.nome);
    if (!nome) continue;
    rawEntries.push({
      username: String(item?.username || '').trim() || null,
      nome,
      origem: 'crm',
    });
  }

  for (const r of dbRows) {
    const nome = normNome(r.nome);
    if (!nome) continue;
    rawEntries.push({
      username: null,
      nome,
      origem: 'banco',
    });
  }

  const resolver = buildConsultorResolver(
    rawEntries.map((e) => e.nome),
    externos
  );

  const byKey = new Map();
  for (const entry of rawEntries) {
    const key = resolver.resolveKey(entry.nome);
    if (!key) continue;
    const canonical = resolver.displayName(key);
    const existing = byKey.get(key);
    if (!existing) {
      byKey.set(key, {
        username: entry.username,
        nome: canonical,
        origem: entry.origem,
      });
      continue;
    }
    if (!existing.username && entry.username) existing.username = entry.username;
    if (existing.origem !== 'crm' && entry.origem === 'crm') {
      existing.origem = 'crm';
      existing.nome = canonical;
    }
  }

  const metaByKey = new Map();
  for (const m of metas) {
    const key = resolver.resolveKey(m.consultor_nome);
    if (!key) continue;
    if (!metaByKey.has(key)) metaByKey.set(key, m);
  }

  return [...byKey.values()]
    .map((row) => {
      const key = resolver.resolveKey(row.nome);
      const meta = metaByKey.get(key);
      return {
        ...row,
        tem_meta: Boolean(meta),
        meta_marcados: meta?.meta_marcados ?? null,
        meta_id: meta?.id ?? null,
      };
    })
    .sort((a, b) => a.nome.localeCompare(b.nome, 'pt-BR'));
}
