import { query } from '../db/client.js';

/**
 * @param {object} row
 */
export async function upsertDailyStat(row) {
  const { rows } = await query(
    `
    insert into rematricula_daily_stats (
      stat_date, snapshot_id, source, total_em_curso, adimplente, inadimplente,
      pct_inadimplente, delta_total, delta_adimplente, delta_inadimplente,
      novos_inadimplentes, recuperados_financeiro, sairam_da_base,
      ativacoes_dia, capture_reason, captured_at
    ) values (
      $1::date, $2::uuid, $3, $4, $5, $6,
      $7, $8, $9, $10,
      $11, $12, $13,
      $14, $15, now()
    )
    on conflict (stat_date) do update set
      snapshot_id = excluded.snapshot_id,
      source = excluded.source,
      total_em_curso = excluded.total_em_curso,
      adimplente = excluded.adimplente,
      inadimplente = excluded.inadimplente,
      pct_inadimplente = excluded.pct_inadimplente,
      delta_total = excluded.delta_total,
      delta_adimplente = excluded.delta_adimplente,
      delta_inadimplente = excluded.delta_inadimplente,
      novos_inadimplentes = excluded.novos_inadimplentes,
      recuperados_financeiro = excluded.recuperados_financeiro,
      sairam_da_base = excluded.sairam_da_base,
      ativacoes_dia = excluded.ativacoes_dia,
      capture_reason = excluded.capture_reason,
      captured_at = now()
    returning *
    `,
    [
      row.stat_date,
      row.snapshot_id,
      row.source,
      row.total_em_curso,
      row.adimplente,
      row.inadimplente,
      row.pct_inadimplente,
      row.delta_total,
      row.delta_adimplente,
      row.delta_inadimplente,
      row.novos_inadimplentes,
      row.recuperados_financeiro,
      row.sairam_da_base,
      row.ativacoes_dia,
      row.capture_reason,
    ]
  );
  return rows[0];
}

/** @param {number} [days] */
export async function listDailyStats(days = 30) {
  const lim = Math.min(Math.max(Number(days) || 30, 1), 365);
  const { rows } = await query(
    `
    select *
    from rematricula_daily_stats
    order by stat_date desc
    limit $1
    `,
    [lim]
  );
  return rows.reverse();
}

/** @param {string} from YYYY-MM-DD @param {string} to YYYY-MM-DD */
export async function listDailyStatsBetween(from, to) {
  const { rows } = await query(
    `
    select *
    from rematricula_daily_stats
    where stat_date >= $1::date and stat_date <= $2::date
    order by stat_date asc
    `,
    [from, to]
  );
  return rows;
}

/** @param {string} statDate YYYY-MM-DD */
export async function getStatByDate(statDate) {
  const { rows } = await query(
    `select * from rematricula_daily_stats where stat_date = $1::date limit 1`,
    [statDate]
  );
  return rows[0] || null;
}

/** @param {string} statDate YYYY-MM-DD */
export async function getPreviousStatBefore(statDate) {
  const { rows } = await query(
    `
    select *
    from rematricula_daily_stats
    where stat_date < $1::date
    order by stat_date desc
    limit 1
    `,
    [statDate]
  );
  return rows[0] || null;
}

/** @param {string} statDate YYYY-MM-DD BRT */
export async function countActivationsOnDate(statDate) {
  const { rows } = await query(
    `
    select count(*)::int as n
    from activation_dispatch_events
    where category = 'rematricula'
      and status = 'sent'
      and (created_at at time zone 'America/Sao_Paulo')::date = $1::date
    `,
    [statDate]
  );
  return rows[0]?.n ?? 0;
}

/** Ativações rematrícula nos últimos N dias (BRT). */
export async function activationsByDay(days = 30) {
  const lim = Math.min(Math.max(Number(days) || 30, 1), 365);
  const { rows } = await query(
    `
    select
      (created_at at time zone 'America/Sao_Paulo')::date as day,
      count(*)::int as n
    from activation_dispatch_events
    where category = 'rematricula'
      and status = 'sent'
      and created_at >= now() - ($1::int || ' days')::interval
    group by 1
    order by 1
    `,
    [lim]
  );
  return rows;
}

/** @param {string} from YYYY-MM-DD @param {string} to YYYY-MM-DD */
export async function activationsByDayBetween(from, to) {
  const { rows } = await query(
    `
    select
      (created_at at time zone 'America/Sao_Paulo')::date as day,
      count(*)::int as n
    from activation_dispatch_events
    where category = 'rematricula'
      and status = 'sent'
      and (created_at at time zone 'America/Sao_Paulo')::date >= $1::date
      and (created_at at time zone 'America/Sao_Paulo')::date <= $2::date
    group by 1
    order by 1
    `,
    [from, to]
  );
  return rows;
}
