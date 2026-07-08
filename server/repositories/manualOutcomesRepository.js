import { randomUUID } from 'crypto';
import { query, getPool } from '../db/client.js';
import { masterKeyFromParts } from '../utils/activationIdentity.js';
import { normalizeBrazilianPhone } from '../utils/phoneNormalizer.js';
import { normalizeRgmCanonical } from '../utils/rgmDisplay.js';
import { aggregateMeuPainelOrigemCounts } from '../utils/meuPainelLabels.js';
import {
  normalizeOrigemAtivacaoFilter,
  sqlOrigemAtivacaoCond,
  sqlOutcomeLinkedToResponseExists,
} from '../utils/origemAtivacaoFilter.js';
import { sqlCaaMeuPainelDisplayConsultor } from '../utils/caaConsultorAllowlist.js';

/**
 * @typedef {Object} ManualOutcomeRow
 * @property {string} id
 * @property {string} category
 * @property {string|null} master_key
 * @property {string|null} rgm
 * @property {string|null} cpf
 * @property {string|null} nome
 * @property {string|null} protocolo
 * @property {'revertido'|'confirmado'|'sem_contato'|'outro'} outcome
 * @property {string|null} motivo
 * @property {string|null} notes
 * @property {string|null} proof_path
 * @property {string|null} proof_mime
 * @property {number|null} proof_size_bytes
 * @property {string} consultor_nome
 * @property {string} occurred_at
 * @property {string} created_at
 */

/**
 * @param {{
 *   category: string,
 *   master_key?: string|null,
 *   rgm?: string|null,
 *   cpf?: string|null,
 *   nome?: string|null,
 *   protocolo?: string|null,
 *   outcome: string,
 *   motivo?: string|null,
 *   notes?: string|null,
 *   consultor_nome: string,
 *   occurred_at?: Date|string|null,
 * }} data
 * @returns {Promise<ManualOutcomeRow>}
 */
export async function insertOutcome(data) {
  const { rows } = await query(
    `insert into activation_manual_outcomes
       (category, master_key, rgm, cpf, nome, protocolo, outcome,
        motivo, notes, consultor_nome, occurred_at)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
     returning *`,
    outcomeInsertParams(data)
  );
  return rows[0];
}

/** @param {Parameters<typeof insertOutcome>[0]} data */
function outcomeInsertParams(data) {
  const rgmCanon = data.rgm ? normalizeRgmCanonical(data.rgm) || String(data.rgm).trim() : null;
  return [
    data.category,
    data.master_key ?? (rgmCanon ? `RGM:${rgmCanon}` : null),
    rgmCanon,
    data.cpf ?? null,
    data.nome ?? null,
    data.protocolo ?? null,
    data.outcome,
    data.motivo ?? null,
    data.notes ?? null,
    data.consultor_nome,
    data.occurred_at ? new Date(data.occurred_at) : new Date(),
  ];
}

/**
 * Insere ou atualiza desfecho por (category, rgm). Sem RGM, cai em insert simples.
 * @param {Parameters<typeof insertOutcome>[0]} data
 * @returns {Promise<ManualOutcomeRow>}
 */
export async function upsertOutcome(data) {
  const rgmCanon = data.rgm ? normalizeRgmCanonical(data.rgm) || String(data.rgm).trim() : null;
  if (!rgmCanon) {
    return insertOutcome(data);
  }

  const { rows } = await query(
    `insert into activation_manual_outcomes
       (category, master_key, rgm, cpf, nome, protocolo, outcome,
        motivo, notes, consultor_nome, occurred_at)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
     on conflict (category, rgm) where rgm is not null
     do update set
       outcome = excluded.outcome,
       motivo = excluded.motivo,
       notes = excluded.notes,
       consultor_nome = excluded.consultor_nome,
       occurred_at = excluded.occurred_at,
       master_key = coalesce(excluded.master_key, activation_manual_outcomes.master_key),
       nome = coalesce(excluded.nome, activation_manual_outcomes.nome),
       cpf = coalesce(excluded.cpf, activation_manual_outcomes.cpf),
       protocolo = coalesce(excluded.protocolo, activation_manual_outcomes.protocolo)
     returning *`,
    outcomeInsertParams({ ...data, rgm: rgmCanon })
  );
  return rows[0];
}

/**
 * Preenche rgm/master_key na resposta quando o webhook não trouxe (ex.: CAA ATM).
 * @param {string} responseId
 * @param {{ rgm?: string|null, master_key?: string|null }} data
 */
export async function backfillResponseIdentity(responseId, data = {}) {
  const rgmCanon = data.rgm ? normalizeRgmCanonical(data.rgm) || String(data.rgm).trim() : null;
  const masterKey = data.master_key ?? (rgmCanon ? `RGM:${rgmCanon}` : null);
  if (!rgmCanon && !masterKey) return;
  await query(
    `update activation_responses
        set rgm = coalesce(nullif(trim(rgm), ''), $2),
            master_key = coalesce(nullif(trim(master_key), ''), $3)
      where id = $1`,
    [responseId, rgmCanon, masterKey]
  );
}

/** Match bidirecional parcial entre nome do consultor atribuído e quem está marcando. */
export function consultorNomeMatches(assignedNome, callerNome) {
  const assigned = String(assignedNome || '').trim();
  const caller = String(callerNome || '').trim();
  if (!assigned || !caller) return false;
  const a = assigned.toLowerCase();
  const c = caller.toLowerCase();
  return a.includes(c) || c.includes(a);
}

/**
 * @param {string} responseId
 * @returns {Promise<{ id: string, rgm: string|null, master_key: string|null, consultor_responsavel_nome: string|null }|null>}
 */
export async function getActivationResponseById(responseId) {
  const { rows } = await query(
    `select id, rgm, master_key, consultor_responsavel_nome
       from activation_responses
      where id = $1`,
    [responseId]
  );
  return rows[0] ?? null;
}

/**
 * Valida permissão e formato ao preencher RGM em lead que ainda não tem na resposta.
 * @param {string} responseId
 * @param {{ consultorNome: string, fullAccess?: boolean, rgm?: string|null }} opts
 */
export async function assertCanSetResponseRgm(responseId, opts) {
  const row = await getActivationResponseById(responseId);
  if (!row) {
    const err = new Error('Lead nao encontrado.');
    err.status = 404;
    throw err;
  }

  const storedRgm = row.rgm ? String(row.rgm).trim() : '';
  const incomingRgm = opts.rgm ? normalizeRgmCanonical(opts.rgm) || String(opts.rgm).trim() : '';

  if (storedRgm) {
    const storedCanon = normalizeRgmCanonical(storedRgm) || storedRgm;
    if (incomingRgm && incomingRgm !== storedCanon) {
      const err = new Error('RGM ja cadastrado neste lead.');
      err.status = 409;
      throw err;
    }
    return row;
  }

  if (!incomingRgm) return row;

  if (
    !opts.fullAccess
    && !consultorNomeMatches(row.consultor_responsavel_nome, opts.consultorNome)
  ) {
    const err = new Error('Somente o consultor responsavel pode preencher o RGM deste lead.');
    err.status = 403;
    throw err;
  }

  const canon = normalizeRgmCanonical(incomingRgm);
  if (!canon || canon.replace(/\D/g, '').length < 5) {
    const err = new Error('RGM invalido. Informe o numero de matricula (8 digitos).');
    err.status = 400;
    throw err;
  }

  return row;
}

/**
 * @param {string} id
 * @returns {Promise<ManualOutcomeRow|null>}
 */
export async function findById(id) {
  const { rows } = await query(
    `select * from activation_manual_outcomes where id = $1`,
    [id]
  );
  return rows[0] ?? null;
}

/**
 * @param {{
 *   category?: string,
 *   rgm?: string,
 *   outcome?: string,
 *   consultor?: string,
 *   from?: string,
 *   to?: string,
 *   limit?: string|number,
 *   offset?: string|number,
 * }} filters
 * @returns {Promise<ManualOutcomeRow[]>}
 */
export async function listOutcomes(filters = {}) {
  const params = [];
  const wheres = [];

  if (filters.category) {
    params.push(filters.category);
    wheres.push(`category = $${params.length}`);
  }
  if (filters.rgm) {
    params.push(filters.rgm);
    wheres.push(`rgm = $${params.length}`);
  }
  if (filters.outcome) {
    params.push(filters.outcome);
    wheres.push(`outcome = $${params.length}`);
  }
  if (filters.consultor) {
    params.push(`%${filters.consultor}%`);
    wheres.push(`consultor_nome ilike $${params.length}`);
  }
  if (filters.from) {
    params.push(new Date(filters.from));
    wheres.push(`occurred_at >= $${params.length}`);
  }
  if (filters.to) {
    params.push(new Date(filters.to));
    wheres.push(`occurred_at <= $${params.length}`);
  }
  if (filters.search) {
    params.push(`%${filters.search}%`);
    wheres.push(`(rgm ilike $${params.length} or nome ilike $${params.length})`);
  }

  const where = wheres.length ? `where ${wheres.join(' and ')}` : '';
  const limit = Math.min(Math.max(parseInt(String(filters.limit ?? '100'), 10) || 100, 1), 500);
  const offset = Math.max(parseInt(String(filters.offset ?? '0'), 10) || 0, 0);
  params.push(limit, offset);

  const { rows } = await query(
    `select id, category, master_key, rgm, cpf, nome, protocolo,
            outcome, motivo, notes,
            proof_path is not null as has_proof,
            proof_mime, proof_size_bytes,
            consultor_nome, occurred_at, created_at
       from activation_manual_outcomes
      ${where}
      order by occurred_at desc
      limit $${params.length - 1} offset $${params.length}`,
    params
  );
  return rows;
}

/**
 * @param {string} id
 * @param {{ proof_path: string, proof_mime: string, proof_size_bytes: number }} data
 * @returns {Promise<ManualOutcomeRow|null>}
 */
export async function updateProof(id, { proof_path, proof_mime, proof_size_bytes }) {
  const { rows } = await query(
    `update activation_manual_outcomes
        set proof_path = $2, proof_mime = $3, proof_size_bytes = $4
      where id = $1
      returning *`,
    [id, proof_path, proof_mime, proof_size_bytes]
  );
  return rows[0] ?? null;
}

/**
 * @param {string} id
 * @returns {Promise<{ id: string, proof_path: string|null }|null>}
 */
export async function clearProof(id) {
  const { rows } = await query(
    `update activation_manual_outcomes
        set proof_path = null, proof_mime = null, proof_size_bytes = null
      where id = $1
      returning id, proof_path`,
    [id]
  );
  return rows[0] ?? null;
}

/**
 * @param {string} id
 * @returns {Promise<{ id: string, proof_path: string|null }|null>}
 */
export async function deleteById(id) {
  const { rows } = await query(
    `delete from activation_manual_outcomes where id = $1
     returning id, proof_path`,
    [id]
  );
  return rows[0] ?? null;
}

/**
 * Remove todos os desfechos de um RGM numa categoria.
 * Retorna a lista de ids deletados (com proof_path para limpeza de arquivo se necessário).
 * @param {string} rgm
 * @param {string} category
 * @returns {Promise<Array<{ id: string, proof_path: string|null }>>}
 */
export async function deleteByRgmAndCategory(rgm, category) {
  const { rows } = await query(
    `delete from activation_manual_outcomes
      where rgm = $1 and category = $2
      returning id, proof_path`,
    [rgm, category]
  );
  return rows;
}

/**
 * Insere desfecho originado do sync do CRM (sem proof, consultor automático).
 * @param {{
 *   category: string,
 *   rgm?: string|null,
 *   datacrazy_lead_id?: string|null,
 *   nome?: string|null,
 *   outcome: string,
 *   motivo?: string|null,
 *   notes?: string|null,
 *   occurred_at?: Date|string|null,
 * }} data
 * @returns {Promise<ManualOutcomeRow>}
 */
export async function createFromCrm(data) {
  const masterKey = data.rgm ? `RGM:${data.rgm}` : null;
  return upsertOutcome({
    category: data.category,
    master_key: masterKey,
    rgm: data.rgm ?? null,
    cpf: null,
    nome: data.nome ?? null,
    protocolo: null,
    outcome: data.outcome,
    motivo: data.motivo ?? null,
    notes: data.notes ?? null,
    consultor_nome: 'DataCrazy CRM (auto)',
    occurred_at: data.occurred_at ?? new Date(),
  });
}

/* ============================================================================
   MEU PAINEL — funções para a página de marcação por consultor
   ----------------------------------------------------------------------------
   Cruzam activation_responses (leads atribuídos via webhook do n8n) com
   caa_protocols (status atual do CAA) e activation_manual_outcomes (última
   marcação manual do consultor). Usadas em GET /api/activation/meu-painel/*.
   ========================================================================== */

/**
 * Lista leads atribuídos ao consultor (consultor_responsavel_nome) com status
 * CAA atual e última marcação manual (se houver). Se consultorNome for null
 * ou '*', retorna todos (modo admin).
 *
 * @param {{
 *   consultor?: string|null,
 *   from?: string|Date|null,
 *   to?: string|Date|null,
 *   category?: string|null,
 *   limit?: number,
 *   offset?: number,
 * }} filters
 * @returns {Promise<{ items: Array<object>, total: number }>}
 */
function meuPainelFilterParams(filters = {}) {
  const isAdmin = !filters.consultor || filters.consultor === '*';
  const consultorTrim = isAdmin ? null : String(filters.consultor).trim();
  const fromDate = filters.from ? new Date(filters.from) : null;
  let toDate = null;
  if (filters.to) {
    const d = filters.to instanceof Date ? new Date(filters.to) : new Date(filters.to);
    d.setUTCDate(d.getUTCDate() + 1);
    toDate = d;
  }
  const category = filters.category ? String(filters.category).trim() : null;
  const origemAtivacao = normalizeOrigemAtivacaoFilter(filters.origem_ativacao);
  const searchRaw = filters.search ? String(filters.search).trim().slice(0, 120) : '';
  const search = searchRaw || null;
  const somenteAtribuidos =
    filters.somente_atribuidos === true ||
    filters.somente_atribuidos === 1 ||
    filters.somente_atribuidos === '1' ||
    filters.somente_atribuidos === 'true';
  return { consultorTrim, fromDate, toDate, category, origemAtivacao, search, somenteAtribuidos };
}

/** WHERE base do Meu Painel + filtro opcional de origem_ativacao. */
function meuPainelWhereSql(origemAtivacao) {
  return `${MEU_PAINEL_WHERE_SQL}${sqlOrigemAtivacaoCond('ar', origemAtivacao)}`;
}

/** RGM efetivo: resposta + matriculados + MV telefone */
const EFFECTIVE_RGM_EXPR = `nullif(trim(coalesce(ar.rgm, mat.rgm, lk.rgm)), '')`;

/** Consultor efetivo: webhook (payload) tem precedência sobre coluna desatualizada. */
export const MEU_PAINEL_EFFECTIVE_CONSULTOR_SQL = `nullif(trim(both from coalesce(
  nullif(trim(ar.raw_payload->>'Consultor'), ''),
  nullif(trim(ar.raw_payload->>'consultor'), ''),
  nullif(trim(ar.consultor_responsavel_nome), '')
)), '')`;

/** Consultor exibido: CAA com nome fora de Wesley/Danubia aparece em branco. */
export const MEU_PAINEL_DISPLAY_CONSULTOR_SQL = sqlCaaMeuPainelDisplayConsultor(
  MEU_PAINEL_EFFECTIVE_CONSULTOR_SQL
);

const MEU_PAINEL_SOMENTE_ATRIBUIDOS_SQL = `and ${MEU_PAINEL_DISPLAY_CONSULTOR_SQL} is not null`;

/** WHERE completo do Meu Painel + filtro opcional somente_atribuidos (Wesley/Danubia em CAA). */
function meuPainelListWhereSql(origemAtivacao, somenteAtribuidos) {
  return `${meuPainelWhereSql(origemAtivacao)}${somenteAtribuidos ? MEU_PAINEL_SOMENTE_ATRIBUIDOS_SQL : ''}`;
}

const MEU_PAINEL_DLC_JOIN = `
left join datacrazy_lead_cache dlc
  on dlc.datacrazy_lead_id = ar.datacrazy_lead_id
`;

const MEU_PAINEL_LK_JOIN = `
left join mv_aluno_por_telefone lk
  on lk.phone_norm = normalize_phone_br(ar.telefone)
`;

const MEU_PAINEL_MAT_LATERAL = `
left join lateral (
  select
    mr.data->>'RGM'   as rgm,
    mr.data->>'Nome'  as nome,
    mr.data->>'Curso' as curso,
    mr.data->>'Polo'  as polo
  from matriculados_rows mr
  where mr.snapshot_id = (
    select id from matriculados_snapshots order by created_at desc limit 1
  )
    and (
      (
        dlc.cpf is not null
        and regexp_replace(coalesce(mr.data->>'CPF', ''), '[^0-9]', '', 'g')
            = regexp_replace(dlc.cpf, '[^0-9]', '', 'g')
      )
      or (
        nullif(trim(coalesce(ar.rgm, '')), '') is not null
        and regexp_replace(coalesce(mr.data->>'RGM', ''), '[^0-9]', '', 'g')
            = regexp_replace(coalesce(ar.rgm, ''), '[^0-9]', '', 'g')
      )
    )
  limit 1
) mat on true
`;

/** Casamento marcação manual ↔ lead (RGM enriquecido, master_key ou CPF). */
const OUTCOME_MATCH_WHERE = `
  amo.category = ar.category
  and (
    (
      ${EFFECTIVE_RGM_EXPR} is not null
      and amo.rgm is not null
      and regexp_replace(amo.rgm, '[^0-9]', '', 'g')
          = regexp_replace(coalesce(ar.rgm, mat.rgm, lk.rgm, ''), '[^0-9]', '', 'g')
      and length(regexp_replace(amo.rgm, '[^0-9]', '', 'g')) >= 5
    )
    or (
      nullif(trim(coalesce(ar.master_key, '')), '') is not null
      and amo.master_key is not null
      and amo.master_key = ar.master_key
    )
    or (
      amo.cpf is not null
      and length(regexp_replace(amo.cpf, '[^0-9]', '', 'g')) = 11
      and regexp_replace(amo.cpf, '[^0-9]', '', 'g') = regexp_replace(
        coalesce(dlc.cpf, nullif(trim(ar.raw_payload->>'cpf'), ''), nullif(trim(lk.cpf), ''), ''),
        '[^0-9]', '', 'g'
      )
    )
  )
`;

const MEU_PAINEL_OUTCOME_LATERAL = `
left join lateral (
  select id, outcome, motivo, notes, occurred_at, consultor_nome, proof_path
    from activation_manual_outcomes amo
   where ${OUTCOME_MATCH_WHERE}
   order by occurred_at desc
   limit 1
) amo on true
`;

const MEU_PAINEL_WHERE_SQL = `
  (
    $1::text is null
    or (
      ${MEU_PAINEL_DISPLAY_CONSULTOR_SQL} is not null
      and (
        ${MEU_PAINEL_DISPLAY_CONSULTOR_SQL} ilike '%' || $1::text || '%'
        or $1::text ilike '%' || ${MEU_PAINEL_DISPLAY_CONSULTOR_SQL} || '%'
      )
    )
  )
  and ($2::timestamptz is null or ar.received_at >= $2)
  and ($3::timestamptz is null or ar.received_at < $3)
  and ($4::text is null or ar.category = $4)
`;

/** Busca no servidor (nome, RGM, CPF, telefone, protocolo…) — param $5. */
const MEU_PAINEL_SEARCH_SQL = `
  and (
    $5::text is null
    or (
      ar.rgm ilike '%' || $5 || '%'
      or ar.telefone ilike '%' || $5 || '%'
      or ar.master_key ilike '%' || $5 || '%'
      or coalesce(ar.consultor_responsavel_nome, '') ilike '%' || $5 || '%'
      or coalesce(ar.raw_payload->>'nome', '') ilike '%' || $5 || '%'
      or coalesce(ar.raw_payload->>'cpf', '') ilike '%' || $5 || '%'
      or coalesce(ar.raw_payload->>'protocolo', '') ilike '%' || $5 || '%'
      or coalesce(ar.raw_payload->>'curso', '') ilike '%' || $5 || '%'
      or coalesce(ar.raw_payload->>'polo', '') ilike '%' || $5 || '%'
      or coalesce(ar.message_text, '') ilike '%' || $5 || '%'
      or ${EFFECTIVE_RGM_EXPR} ilike '%' || $5 || '%'
      or coalesce(mat.nome, '') ilike '%' || $5 || '%'
      or coalesce(dlc.nome, '') ilike '%' || $5 || '%'
      or coalesce(lk.nome, '') ilike '%' || $5 || '%'
      or coalesce(cp.protocolo, '') ilike '%' || $5 || '%'
      or (
        length(regexp_replace($5, '[^0-9]', '', 'g')) >= 5
        and regexp_replace(coalesce(${EFFECTIVE_RGM_EXPR}, ar.rgm, ''), '[^0-9]', '', 'g')
            like '%' || regexp_replace($5, '[^0-9]', '', 'g') || '%'
      )
    )
  )
`;

const MEU_PAINEL_CP_LATERAL = `
left join lateral (
  select protocolo, nome, cpf, curso, polo, status, last_status_change_at
  from caa_protocols c
  where (
    ${EFFECTIVE_RGM_EXPR} is not null
    and c.rgm = ${EFFECTIVE_RGM_EXPR}
  )
     or (
    dlc.cpf is not null
    and c.cpf is not null
    and regexp_replace(c.cpf, '[^0-9]', '', 'g') = regexp_replace(dlc.cpf, '[^0-9]', '', 'g')
  )
  order by c.last_status_change_at desc nulls last
  limit 1
) cp on true
`;

const MEU_PAINEL_CORE_FROM = `
  from activation_responses ar
  ${MEU_PAINEL_DLC_JOIN}
  ${MEU_PAINEL_LK_JOIN}
  ${MEU_PAINEL_MAT_LATERAL}
  ${MEU_PAINEL_CP_LATERAL}
`;

export const MEU_PAINEL_PAGE_SIZES = [50, 100, 200, 300];

/** @param {unknown} raw */
export function parseMeuPainelPageSize(raw) {
  const n = parseInt(String(raw ?? '50'), 10);
  return MEU_PAINEL_PAGE_SIZES.includes(n) ? n : 50;
}

/**
 * Total de leads no Meu Painel (mesmos filtros da listagem).
 * @param {Parameters<typeof listMeuPainel>[0]} filters
 */
export async function countMeuPainel(filters = {}) {
  const { consultorTrim, fromDate, toDate, category, origemAtivacao, search, somenteAtribuidos } =
    meuPainelFilterParams(filters);
  const { rows } = await query(
    `select count(*)::int as total
     ${MEU_PAINEL_CORE_FROM}
     where ${meuPainelListWhereSql(origemAtivacao, somenteAtribuidos)}
     ${MEU_PAINEL_SEARCH_SQL}`,
    [consultorTrim, fromDate, toDate, category, search]
  );
  return Number(rows[0]?.total || 0);
}

export async function listMeuPainel(filters = {}) {
  const { consultorTrim, fromDate, toDate, category, origemAtivacao, search, somenteAtribuidos } =
    meuPainelFilterParams(filters);
  const limit = parseMeuPainelPageSize(filters.limit);
  const offset = Math.max(parseInt(String(filters.offset ?? '0'), 10) || 0, 0);
  const whereParams = [consultorTrim, fromDate, toDate, category, search];

  const [listResult, total] = await Promise.all([
    query(
    `
    select
      ar.id                            as response_id,
      ar.category                      as category,
      ar.master_key                    as master_key,
      coalesce(
        nullif(trim(ar.rgm), ''),
        nullif(trim(mat.rgm), ''),
        nullif(trim(lk.rgm), '')
      )                                as rgm,
      nullif(trim(ar.rgm), '')         as response_rgm,
      ar.telefone                      as telefone,
      ${MEU_PAINEL_DISPLAY_CONSULTOR_SQL} as consultor_responsavel_nome,
      ar.origem_ativacao               as origem_ativacao,
      ar.response_kind                 as response_kind,
      ar.message_text                  as message_text,
      ar.button_payload                as button_payload,
      ar.received_at                   as received_at,
      coalesce(
        cp.protocolo,
        nullif(trim(ar.raw_payload->>'protocolo'), '')
      )                                as protocolo,
      coalesce(
        cp.nome,
        dlc.nome,
        mat.nome,
        nullif(trim(ar.raw_payload->>'nome'), ''),
        nullif(trim(ar.raw_payload->>'nome do lead'), ''),
        nullif(trim(ar.raw_payload->>'Nome do Lead'), ''),
        lk.nome
      )                                as nome,
      coalesce(
        cp.cpf,
        dlc.cpf,
        nullif(trim(ar.raw_payload->>'cpf'), ''),
        nullif(trim(lk.cpf), '')
      )                                as cpf,
      coalesce(
        cp.curso,
        mat.curso,
        nullif(trim(ar.raw_payload->>'curso'), '')
      )                                as curso,
      coalesce(
        cp.polo,
        mat.polo,
        nullif(trim(ar.raw_payload->>'polo'), '')
      )                                as polo,
      cp.status                        as caa_status,
      cp.last_status_change_at         as caa_last_change_at,
      amo.id                           as outcome_id,
      amo.outcome                      as outcome,
      amo.motivo                       as outcome_motivo,
      amo.notes                        as outcome_notes,
      amo.occurred_at                  as outcome_occurred_at,
      amo.consultor_nome               as outcome_consultor_nome,
      amo.proof_path is not null       as outcome_has_proof,
      (
        ar.external_id like 'manual:%'
        or coalesce((ar.raw_payload->>'manual')::boolean, false)
      )                                as is_manual
    ${MEU_PAINEL_CORE_FROM}
    ${MEU_PAINEL_OUTCOME_LATERAL}
    where ${meuPainelListWhereSql(origemAtivacao, somenteAtribuidos)}
    ${MEU_PAINEL_SEARCH_SQL}
    order by ar.received_at desc
    limit $6 offset $7
    `,
      [...whereParams, limit, offset]
    ),
    countMeuPainel(filters),
  ]);
  return { items: listResult.rows, total };
}

/**
 * KPIs do consultor.
 * - Atribuídos: leads recebidos no período (received_at).
 * - Marcados/Revertidos/etc.: desfechos registrados no período (occurred_at),
 *   alinhado à meta diária do Painel Geral.
 *
 * @param {{
 *   consultor?: string|null,
 *   from?: string|Date|null,
 *   to?: string|Date|null,
 *   category?: string|null,
 * }} filters
 * @returns {Promise<{
 *   total_atribuido: number,
 *   total_opt_out: number,
 *   total_marcado: number,
 *   total_revertido: number,
 *   total_confirmado: number,
 *   total_sem_contato: number,
 *   total_outro: number,
 *   taxa_reversao: number,
 * }>}
 */
/** KPIs de marcação por data do desfecho (occurred_at) — alinhado à meta diária. */
async function meuPainelOutcomeStats(filters = {}) {
  const { consultorTrim, fromDate, toDate, category, origemAtivacao } = meuPainelFilterParams(filters);
  const origemOutcomeCond = origemAtivacao
    ? `and ${sqlOutcomeLinkedToResponseExists('amo', origemAtivacao)}`
    : '';
  const { rows } = await query(
    `
    select
      count(*)::int as total_marcado,
      count(*) filter (where outcome = 'revertido')::int as total_revertido,
      count(*) filter (where outcome = 'confirmado')::int as total_confirmado,
      count(*) filter (where outcome = 'sem_contato')::int as total_sem_contato,
      count(*) filter (where outcome = 'outro')::int as total_outro
    from activation_manual_outcomes amo
    where ($1::timestamptz is null or amo.occurred_at >= $1)
      and ($2::timestamptz is null or amo.occurred_at < $2)
      and (
        $3::text is null
        or (
          amo.consultor_nome is not null
          and (
            amo.consultor_nome ilike '%' || $3::text || '%'
            or $3::text ilike '%' || amo.consultor_nome || '%'
          )
        )
      )
      and ($4::text is null or amo.category = $4)
      ${origemOutcomeCond}
    `,
    [fromDate, toDate, consultorTrim, category]
  );
  return rows[0] || {};
}

export async function meuPainelStats(filters = {}) {
  const { consultorTrim, fromDate, toDate, category, origemAtivacao } = meuPainelFilterParams(filters);

  const [attribRows, outcomeRow] = await Promise.all([
    query(
      `
      with enriched as (
        select ar.id, ar.response_kind
        from activation_responses ar
        where ${meuPainelWhereSql(origemAtivacao)}
      )
      select
        (select count(*)::int from enriched) as total_atribuido,
        (select count(*)::int from enriched where response_kind = 'opt_out') as total_opt_out
      `,
      [consultorTrim, fromDate, toDate, category]
    ),
    meuPainelOutcomeStats(filters),
  ]);
  const rows = attribRows.rows;
  const r = rows[0] || {};
  const o = outcomeRow || {};
  const totalMarcado = Number(o.total_marcado || 0);
  const totalRevertido = Number(o.total_revertido || 0);
  const taxaReversao = totalMarcado > 0 ? totalRevertido / totalMarcado : 0;
  return {
    total_atribuido: Number(r.total_atribuido || 0),
    total_opt_out: Number(r.total_opt_out || 0),
    total_marcado: totalMarcado,
    total_revertido: totalRevertido,
    total_confirmado: Number(o.total_confirmado || 0),
    total_sem_contato: Number(o.total_sem_contato || 0),
    total_outro: Number(o.total_outro || 0),
    taxa_reversao: taxaReversao,
  };
}

/**
 * Contagem por categoria + origem_ativacao (mesmos filtros do Meu Painel).
 * Usa `vw_meu_painel_origem_ativacao` (migration 038).
 *
 * @param {{
 *   consultor?: string|null,
 *   from?: string|Date|null,
 *   to?: string|Date|null,
 *   category?: string|null,
 * }} filters
 * @returns {Promise<Array<{ key: string, label: string, total: number }>>}
 */
export async function meuPainelOrigemCounts(filters = {}) {
  const isAdmin = !filters.consultor || filters.consultor === '*';
  const consultorTrim = isAdmin ? null : String(filters.consultor).trim();
  const fromDate = filters.from ? new Date(filters.from) : null;
  let toDate = null;
  if (filters.to) {
    const d = filters.to instanceof Date ? new Date(filters.to) : new Date(filters.to);
    d.setUTCDate(d.getUTCDate() + 1);
    toDate = d;
  }
  const category = filters.category ? String(filters.category).trim() : null;
  const origemAtivacao = normalizeOrigemAtivacaoFilter(filters.origem_ativacao);

  const { rows } = await query(
    `
    select
      ar.category,
      coalesce(nullif(trim(ar.origem_ativacao), ''), '') as origem_ativacao,
      count(*)::int as total
    from activation_responses ar
    where (
      $1::text is null
      or (
        ${MEU_PAINEL_DISPLAY_CONSULTOR_SQL} is not null
        and (
          ${MEU_PAINEL_DISPLAY_CONSULTOR_SQL} ilike '%' || $1::text || '%'
          or $1::text ilike '%' || ${MEU_PAINEL_DISPLAY_CONSULTOR_SQL} || '%'
        )
      )
    )
      and ($2::timestamptz is null or ar.received_at >= $2)
      and ($3::timestamptz is null or ar.received_at < $3)
      and ($4::text is null or ar.category = $4)
      ${sqlOrigemAtivacaoCond('ar', origemAtivacao)}
    group by ar.category, coalesce(nullif(trim(ar.origem_ativacao), ''), '')
    order by total desc, ar.category, origem_ativacao
    `,
    [consultorTrim, fromDate, toDate, category]
  );
  const raw = rows.map((r) => ({
    category: r.category,
    origem_ativacao: r.origem_ativacao || '',
    total: Number(r.total || 0),
  }));
  return aggregateMeuPainelOrigemCounts(raw);
}

function normalizePhoneInput(input) {
  if (!input) return null;
  const n = normalizeBrazilianPhone(input);
  return n.ok ? n.phone : String(input).replace(/\D+/g, '') || null;
}

function normalizeCpfInput(input) {
  const d = String(input ?? '').replace(/\D/g, '');
  return d.length === 11 ? d : null;
}

/**
 * Cadastro manual de lead no Meu Painel (ex.: CAA que não entrou via webhook).
 * Grava `activation_responses`; `caa_protocols` só quando há protocolo (relatório CAA).
 *
 * @param {{
 *   category: string,
 *   origem_ativacao?: string|null,
 *   protocolo?: string|null,
 *   rgm: string,
 *   nome?: string|null,
 *   cpf?: string|null,
 *   telefone?: string|null,
 *   curso?: string|null,
 *   polo?: string|null,
 *   consultor_nome: string,
 * }} input
 */
export async function createManualMeuPainelLead(input) {
  const category = String(input.category || '').trim();
  const protocoloRaw = String(input.protocolo || '').replace(/\D/g, '');
  const rgm = normalizeRgmCanonical(input.rgm);
  const consultorNome = String(input.consultor_nome || '').trim().slice(0, 200);
  const nome = input.nome ? String(input.nome).trim().slice(0, 200) : null;
  const cpf = normalizeCpfInput(input.cpf);
  const telefone = normalizePhoneInput(input.telefone);
  const curso = input.curso ? String(input.curso).trim().slice(0, 200) : null;
  const polo = input.polo ? String(input.polo).trim().slice(0, 200) : null;

  const VALID_ORIGENS_CAA = new Set(['caa', 'caa_atm', 'caa_ia']);
  let origemAtivacao = String(input.origem_ativacao || 'caa_atm').trim().toLowerCase();
  if (!VALID_ORIGENS_CAA.has(origemAtivacao)) {
    origemAtivacao = 'caa_atm';
  }

  if (category !== 'processos-caa') {
    const err = new Error('Cadastro manual disponivel apenas para processos-caa.');
    err.status = 400;
    throw err;
  }

  const hasProtocol =
    protocoloRaw.length >= 9 && protocoloRaw.length <= 12;

  if (origemAtivacao === 'caa' && !hasProtocol) {
    const err = new Error(
      'Protocolo CAA obrigatorio para Processos CAA (9 a 12 digitos).'
    );
    err.status = 400;
    throw err;
  }
  if (protocoloRaw && !hasProtocol) {
    const err = new Error('Protocolo CAA invalido (9 a 12 digitos).');
    err.status = 400;
    throw err;
  }

  if (!rgm) {
    const err = new Error('RGM e obrigatorio.');
    err.status = 400;
    throw err;
  }
  if (!consultorNome) {
    const err = new Error('consultor_nome e obrigatorio.');
    err.status = 400;
    throw err;
  }

  const masterKey = masterKeyFromParts({ rgm, cpf, telefone });
  if (!masterKey) {
    const err = new Error('Nao foi possivel gerar master_key (informe RGM valido).');
    err.status = 400;
    throw err;
  }

  const pool = getPool();
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const { rows: dup } = await client.query(
      `select id, consultor_responsavel_nome, received_at, origem_ativacao, external_id
         from activation_responses
        where category = $1 and rgm = $2
        limit 1`,
      [category, rgm]
    );
    if (dup.length) {
      const existing = dup[0];
      const when = existing.received_at
        ? new Date(existing.received_at).toLocaleDateString('pt-BR')
        : '—';
      const consultor = existing.consultor_responsavel_nome || '—';
      const err = new Error(
        `Ja existe um lead com este RGM em Processos CAA (consultor: ${consultor}, recebido em ${when}). ` +
          'Use a busca com periodo "Tudo" para localiza-lo.'
      );
      err.status = 409;
      throw err;
    }

    const manualMeta = JSON.stringify({
      manual: true,
      source: 'meu_painel',
      origem_ativacao: origemAtivacao,
      created_by: consultorNome,
    });

    if (origemAtivacao === 'caa' && hasProtocol) {
      await client.query(
        `insert into caa_protocols (
           protocolo, rgm, cpf, nome, telefone, polo, curso, status, data
         ) values ($1, $2, $3, $4, $5, $6, $7, 'open', $8::jsonb)
         on conflict (protocolo) do update set
           rgm        = coalesce(excluded.rgm, caa_protocols.rgm),
           cpf        = coalesce(excluded.cpf, caa_protocols.cpf),
           nome       = coalesce(excluded.nome, caa_protocols.nome),
           telefone   = coalesce(excluded.telefone, caa_protocols.telefone),
           polo       = coalesce(excluded.polo, caa_protocols.polo),
           curso      = coalesce(excluded.curso, caa_protocols.curso),
           last_seen_at = now(),
           data       = caa_protocols.data || excluded.data`,
        [protocoloRaw, rgm, cpf, nome, telefone, polo, curso, manualMeta]
      );
    }

    const messageLabel =
      origemAtivacao === 'caa_atm'
        ? 'Cadastro manual — CAA_ATM (conversa com atendente)'
        : origemAtivacao === 'caa_ia'
          ? 'Cadastro manual — CAA_IA'
          : 'Cadastro manual — relatório CAA';

    const externalId = `manual:${randomUUID()}`;
    const { rows } = await client.query(
      `insert into activation_responses (
         category, master_key, telefone, rgm, origem_ativacao,
         response_kind, message_text, external_id,
         raw_payload, received_at, consultor_responsavel_nome
       ) values ($1, $2, $3, $4, $5, 'other', $6, $7, $8::jsonb, now(), $9)
       returning id, category, master_key, rgm, telefone, origem_ativacao,
                 consultor_responsavel_nome, received_at`,
      [
        category,
        masterKey,
        telefone,
        rgm,
        origemAtivacao,
        messageLabel,
        externalId,
        JSON.stringify({
          manual: true,
          origem_ativacao: origemAtivacao,
          protocolo: hasProtocol ? protocoloRaw : null,
          nome,
          cpf,
          curso,
          polo,
        }),
        consultorNome,
      ]
    );

    await client.query('COMMIT');
    return {
      ok: true,
      row: {
        ...rows[0],
        protocolo: hasProtocol ? protocoloRaw : null,
        nome,
        cpf,
        curso,
        polo,
      },
    };
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Exclui lead criado manualmente no Meu Painel (external_id manual:*).
 * Nao remove leads gravados via webhook/disparo.
 *
 * @param {string} responseId
 */
export async function deleteManualMeuPainelLead(responseId) {
  const id = String(responseId || '').trim();
  if (!id) {
    const err = new Error('response_id e obrigatorio.');
    err.status = 400;
    throw err;
  }

  const pool = getPool();
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const { rows } = await client.query(
      `select id, category, rgm, external_id, raw_payload
         from activation_responses
        where id = $1`,
      [id]
    );
    if (!rows.length) {
      const err = new Error('Lead nao encontrado.');
      err.status = 404;
      throw err;
    }

    const row = rows[0];
    const payload =
      row.raw_payload && typeof row.raw_payload === 'object' ? row.raw_payload : {};
    const isManual =
      String(row.external_id || '').startsWith('manual:') || payload.manual === true;
    if (!isManual) {
      const err = new Error('So e possivel excluir leads criados manualmente no painel.');
      err.status = 403;
      throw err;
    }

    const protocolo = String(payload.protocolo || '').replace(/\D/g, '');
    if (protocolo.length >= 9 && protocolo.length <= 12) {
      await client.query(
        `delete from caa_protocols
          where protocolo = $1
            and coalesce((data->>'manual')::boolean, false) = true`,
        [protocolo]
      );
    }

    if (row.rgm && row.category) {
      await client.query(
        `delete from activation_manual_outcomes
          where category = $1 and rgm = $2`,
        [row.category, row.rgm]
      );
    }

    await client.query(`delete from activation_responses where id = $1`, [id]);
    await client.query('COMMIT');
    return { ok: true, deleted_id: id };
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}
