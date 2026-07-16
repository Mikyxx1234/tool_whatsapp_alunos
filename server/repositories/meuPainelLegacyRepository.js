import { query } from '../db/client.js';

/**
 * Importa snapshot atual do Meu Painel (activation_responses + outcomes) para
 * meu_painel_legacy_outcomes. Idempotente por response_id.
 */
export async function migrateMeuPainelLegacyFromLive() {
  const { rowCount } = await query(
    `insert into meu_painel_legacy_outcomes (
       source, category, response_id, master_key, rgm, cpf, nome, telefone,
       consultor_nome, origem_ativacao, response_kind, received_at,
       outcome, outcome_motivo, outcome_notes, outcome_occurred_at, raw
     )
     select
       'datacrazy',
       ar.category,
       ar.id::text,
       ar.master_key,
       coalesce(amo.rgm, ar.rgm),
       coalesce(amo.cpf, nullif(trim(ar.raw_payload->>'cpf'), '')),
       coalesce(nullif(trim(ar.raw_payload->>'nome'), ''),
                nullif(trim(ar.raw_payload->>'nome do lead'), ''),
                nullif(trim(ar.raw_payload->>'Nome do Lead'), '')),
       ar.telefone,
       coalesce(amo.consultor_nome, ar.consultor_responsavel_nome),
       ar.origem_ativacao,
       ar.response_kind,
       ar.received_at,
       amo.outcome,
       amo.motivo,
       amo.notes,
       amo.occurred_at,
       jsonb_build_object(
         'response_id', ar.id,
         'outcome_id', amo.id,
         'protocolo', amo.protocolo
       )
     from activation_responses ar
     left join lateral (
       select o.*
         from activation_manual_outcomes o
        where (ar.rgm is not null and o.rgm = ar.rgm and o.category = ar.category)
           or (ar.master_key is not null and o.master_key = ar.master_key and o.category = ar.category)
        order by o.occurred_at desc nulls last, o.created_at desc nulls last
        limit 1
     ) amo on true
     on conflict (response_id) where response_id is not null do update set
       rgm = excluded.rgm,
       cpf = excluded.cpf,
       nome = coalesce(excluded.nome, meu_painel_legacy_outcomes.nome),
       telefone = coalesce(excluded.telefone, meu_painel_legacy_outcomes.telefone),
       consultor_nome = coalesce(excluded.consultor_nome, meu_painel_legacy_outcomes.consultor_nome),
       outcome = coalesce(excluded.outcome, meu_painel_legacy_outcomes.outcome),
       outcome_motivo = coalesce(excluded.outcome_motivo, meu_painel_legacy_outcomes.outcome_motivo),
       outcome_notes = coalesce(excluded.outcome_notes, meu_painel_legacy_outcomes.outcome_notes),
       outcome_occurred_at = coalesce(excluded.outcome_occurred_at, meu_painel_legacy_outcomes.outcome_occurred_at),
       raw = excluded.raw,
       migrated_at = now()`
  );

  const { rows } = await query(`select count(*)::int as n from meu_painel_legacy_outcomes`);
  return { upserted: rowCount ?? 0, total: rows[0]?.n ?? 0 };
}

/**
 * @param {{
 *   category?: string|null,
 *   from?: string|null,
 *   to?: string|null,
 *   consultor?: string|null,
 *   search?: string|null,
 * }} filters
 */
export async function listLegacyMeuPainel(filters = {}) {
  const params = [];
  const where = [`1=1`];

  if (filters.category) {
    params.push(filters.category);
    where.push(`l.category = $${params.length}`);
  }
  if (filters.from) {
    params.push(filters.from);
    where.push(`coalesce(l.outcome_occurred_at, l.received_at) >= $${params.length}::date`);
  }
  if (filters.to) {
    params.push(filters.to);
    where.push(
      `coalesce(l.outcome_occurred_at, l.received_at) < ($${params.length}::date + interval '1 day')`
    );
  }
  if (filters.consultor && filters.consultor !== '*') {
    params.push(`%${filters.consultor}%`);
    where.push(`l.consultor_nome ilike $${params.length}`);
  }
  if (filters.search) {
    params.push(`%${filters.search}%`);
    const i = params.length;
    where.push(
      `(l.nome ilike $${i} or l.rgm ilike $${i} or l.cpf ilike $${i} or l.telefone ilike $${i} or l.master_key ilike $${i})`
    );
  }

  const { rows } = await query(
    `select l.*
       from meu_painel_legacy_outcomes l
      where ${where.join(' and ')}
      order by coalesce(l.outcome_occurred_at, l.received_at) desc nulls last
      limit 5000`,
    params
  );
  return rows;
}
