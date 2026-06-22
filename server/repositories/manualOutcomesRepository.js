import { query } from '../db/client.js';

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
    [
      data.category,
      data.master_key ?? null,
      data.rgm ?? null,
      data.cpf ?? null,
      data.nome ?? null,
      data.protocolo ?? null,
      data.outcome,
      data.motivo ?? null,
      data.notes ?? null,
      data.consultor_nome,
      data.occurred_at ? new Date(data.occurred_at) : new Date(),
    ]
  );
  return rows[0];
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
  return insertOutcome({
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
 * @returns {Promise<Array<object>>}
 */
export async function listMeuPainel(filters = {}) {
  const isAdmin = !filters.consultor || filters.consultor === '*';
  const consultorTrim = isAdmin ? null : String(filters.consultor).trim();
  const fromDate = filters.from ? new Date(filters.from) : null;
  // Advance to midnight of the next day so the full `to` calendar day is included.
  let toDate = null;
  if (filters.to) {
    const d = filters.to instanceof Date ? new Date(filters.to) : new Date(filters.to);
    d.setUTCDate(d.getUTCDate() + 1);
    toDate = d;
  }
  const category = filters.category ? String(filters.category).trim() : null;
  const limit = Math.min(Math.max(parseInt(String(filters.limit ?? '200'), 10) || 200, 1), 1000);
  const offset = Math.max(parseInt(String(filters.offset ?? '0'), 10) || 0, 0);

  const { rows } = await query(
    `
    select
      ar.id                            as response_id,
      ar.category                      as category,
      ar.master_key                    as master_key,
      coalesce(
        nullif(trim(ar.rgm), ''),
        nullif(trim(mat.rgm), '')
      )                                as rgm,
      ar.telefone                      as telefone,
      ar.consultor_responsavel_nome    as consultor_responsavel_nome,
      ar.origem_ativacao               as origem_ativacao,
      ar.response_kind                 as response_kind,
      ar.message_text                  as message_text,
      ar.button_payload                as button_payload,
      ar.received_at                   as received_at,
      cp.protocolo                     as protocolo,
      coalesce(cp.nome, dlc.nome, mat.nome) as nome,
      coalesce(cp.cpf, dlc.cpf)        as cpf,
      coalesce(cp.curso, mat.curso)    as curso,
      coalesce(cp.polo, mat.polo)      as polo,
      cp.status                        as caa_status,
      cp.last_status_change_at         as caa_last_change_at,
      amo.id                           as outcome_id,
      amo.outcome                      as outcome,
      amo.motivo                       as outcome_motivo,
      amo.notes                        as outcome_notes,
      amo.occurred_at                  as outcome_occurred_at,
      amo.consultor_nome               as outcome_consultor_nome,
      amo.proof_path is not null       as outcome_has_proof
    from activation_responses ar
    left join datacrazy_lead_cache dlc
      on dlc.datacrazy_lead_id = ar.datacrazy_lead_id
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
        and dlc.cpf is not null
        and regexp_replace(coalesce(mr.data->>'CPF', ''), '[^0-9]', '', 'g')
            = regexp_replace(dlc.cpf, '[^0-9]', '', 'g')
      limit 1
    ) mat on true
    left join lateral (
      select protocolo, nome, cpf, curso, polo, status, last_status_change_at
      from caa_protocols c
      where (
        nullif(trim(coalesce(ar.rgm, mat.rgm)), '') is not null
        and c.rgm = nullif(trim(coalesce(ar.rgm, mat.rgm)), '')
      )
         or (
        dlc.cpf is not null
        and c.cpf is not null
        and regexp_replace(c.cpf, '[^0-9]', '', 'g') = regexp_replace(dlc.cpf, '[^0-9]', '', 'g')
      )
      order by c.last_status_change_at desc nulls last
      limit 1
    ) cp on true
    left join lateral (
      select id, outcome, motivo, notes, occurred_at, consultor_nome, proof_path
        from activation_manual_outcomes
       where category = ar.category
         and nullif(trim(coalesce(ar.rgm, mat.rgm)), '') is not null
         and rgm = nullif(trim(coalesce(ar.rgm, mat.rgm)), '')
       order by occurred_at desc
       limit 1
    ) amo on true
    -- match bidirecional: "Danubia" salvo casa com consultor "Danubia Sousa" e vice-versa
    where (
      $1::text is null
      or (
        ar.consultor_responsavel_nome is not null
        and (
          ar.consultor_responsavel_nome ilike '%' || $1::text || '%'
          or $1::text ilike '%' || ar.consultor_responsavel_nome || '%'
        )
      )
    )
      and ($2::timestamptz is null or ar.received_at >= $2)
      and ($3::timestamptz is null or ar.received_at < $3)
      and ($4::text is null or ar.category = $4)
    order by ar.received_at desc
    limit $5 offset $6
    `,
    [consultorTrim, fromDate, toDate, category, limit, offset]
  );
  return rows;
}

/**
 * KPIs do consultor: total atribuído, marcados (qualquer outcome),
 * revertido, confirmado, sem_contato, outro, opt_outs.
 * Quando consultor é null/'*', retorna estatísticas globais.
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
export async function meuPainelStats(filters = {}) {
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

  const { rows } = await query(
    `
    with my_responses as (
      select ar.id, ar.category, ar.rgm, ar.response_kind
        from activation_responses ar
       -- match bidirecional: "Danubia" salvo casa com consultor "Danubia Sousa" e vice-versa
       where (
         $1::text is null
         or (
           ar.consultor_responsavel_nome is not null
           and (
             ar.consultor_responsavel_nome ilike '%' || $1::text || '%'
             or $1::text ilike '%' || ar.consultor_responsavel_nome || '%'
           )
         )
       )
         and ($2::timestamptz is null or ar.received_at >= $2)
         and ($3::timestamptz is null or ar.received_at < $3)
         and ($4::text is null or ar.category = $4)
    ),
    latest_outcomes as (
      select distinct on (mr.rgm, mr.category)
             mr.id as response_id, amo.outcome
        from my_responses mr
        left join activation_manual_outcomes amo
          on amo.rgm = mr.rgm
         and amo.category = mr.category
       where mr.rgm is not null
       order by mr.rgm, mr.category, amo.occurred_at desc nulls last
    )
    select
      (select count(*)::int from my_responses)                                              as total_atribuido,
      (select count(*)::int from my_responses where response_kind = 'opt_out')              as total_opt_out,
      (select count(*)::int from latest_outcomes where outcome is not null)                 as total_marcado,
      (select count(*)::int from latest_outcomes where outcome = 'revertido')               as total_revertido,
      (select count(*)::int from latest_outcomes where outcome = 'confirmado')              as total_confirmado,
      (select count(*)::int from latest_outcomes where outcome = 'sem_contato')             as total_sem_contato,
      (select count(*)::int from latest_outcomes where outcome = 'outro')                   as total_outro
    `,
    [consultorTrim, fromDate, toDate, category]
  );
  const r = rows[0] || {};
  const totalMarcado = Number(r.total_marcado || 0);
  const totalRevertido = Number(r.total_revertido || 0);
  const taxaReversao = totalMarcado > 0 ? totalRevertido / totalMarcado : 0;
  return {
    total_atribuido: Number(r.total_atribuido || 0),
    total_opt_out: Number(r.total_opt_out || 0),
    total_marcado: totalMarcado,
    total_revertido: totalRevertido,
    total_confirmado: Number(r.total_confirmado || 0),
    total_sem_contato: Number(r.total_sem_contato || 0),
    total_outro: Number(r.total_outro || 0),
    taxa_reversao: taxaReversao,
  };
}
