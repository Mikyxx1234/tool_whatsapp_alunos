import { query } from '../db/client.js';

const CATEGORY_LABELS = {
  'docs-pendentes': 'Docs pendentes',
  financeiro: 'Financeiro',
  'acessos-blackboard': 'Sem acesso BB',
  'processos-caa': 'Processos CAA',
  'provavel-evasao': 'Provável evasão',
  'aguardando-inicio': 'Aguardando início',
};

const ALL_CATEGORIES = Object.keys(CATEGORY_LABELS);
const RECENT_LIMIT = 50;

/**
 * @param {{ category?: string, period_days?: number, offset?: number }} opts
 */
export async function getActivationConversion({ category = 'all', period_days = 30, offset = 0 } = {}) {
  const periodDays = Math.min(Math.max(Number(period_days) || 30, 1), 365);
  const offsetNum = Math.max(Number(offset) || 0, 0);
  const sinceDate = new Date(Date.now() - periodDays * 24 * 60 * 60 * 1000);
  const sinceIso = sinceDate.toISOString();
  const catFilter = category !== 'all' ? category : null;

  const dispCatCond = catFilter ? 'AND category = $2' : '';
  const respCatCond = catFilter ? 'AND category = $2' : '';
  const dispParams = catFilter ? [sinceIso, catFilter] : [sinceIso];
  const respParams = catFilter ? [sinceIso, catFilter] : [sinceIso];

  // --- KPIs from dispatches ---
  const { rows: [dk] } = await query(
    `SELECT
      COUNT(*)::bigint AS total_dispatches,
      COUNT(DISTINCT master_key) FILTER (WHERE master_key IS NOT NULL)::bigint AS unique_dispatched
    FROM activation_dispatch_events
    WHERE status = 'sent'
      AND created_at >= $1
      ${dispCatCond}`,
    dispParams
  );

  // --- KPIs from responses ---
  const { rows: [rk] } = await query(
    `SELECT
      COUNT(DISTINCT master_key) FILTER (WHERE master_key IS NOT NULL)::bigint AS unique_responders,
      COUNT(DISTINCT master_key) FILTER (WHERE master_key IS NOT NULL AND response_kind = 'click')::bigint AS unique_clickers,
      COUNT(DISTINCT master_key) FILTER (WHERE master_key IS NOT NULL AND response_kind = 'message')::bigint AS unique_messages,
      COUNT(DISTINCT master_key) FILTER (WHERE master_key IS NOT NULL AND response_kind = 'opt_out')::bigint AS unique_opt_outs
    FROM activation_responses
    WHERE COALESCE(received_at, created_at) >= $1
      ${respCatCond}`,
    respParams
  );

  const ud = Number(dk.unique_dispatched) || 0;
  const ur = Number(rk.unique_responders) || 0;
  const uc = Number(rk.unique_clickers) || 0;
  const um = Number(rk.unique_messages) || 0;
  const uo = Number(rk.unique_opt_outs) || 0;

  const kpis = {
    total_dispatches: Number(dk.total_dispatches) || 0,
    unique_dispatched: ud,
    unique_responders: ur,
    unique_clickers: uc,
    unique_messages: um,
    unique_opt_outs: uo,
    response_rate: ud > 0 ? ur / ud : 0,
    opt_out_rate: ud > 0 ? uo / ud : 0,
  };

  // --- by_category: always computed for all categories ---
  const byCatRows = await Promise.all(
    ALL_CATEGORIES.map(async (cat) => {
      const [{ rows: [dr] }, { rows: [rr] }] = await Promise.all([
        query(
          `SELECT
            COUNT(*)::bigint AS total_dispatches,
            COUNT(DISTINCT master_key) FILTER (WHERE master_key IS NOT NULL)::bigint AS unique_dispatched
          FROM activation_dispatch_events
          WHERE status = 'sent' AND created_at >= $1 AND category = $2`,
          [sinceIso, cat]
        ),
        query(
          `SELECT
            COUNT(DISTINCT master_key) FILTER (WHERE master_key IS NOT NULL)::bigint AS unique_responders,
            COUNT(DISTINCT master_key) FILTER (WHERE master_key IS NOT NULL AND response_kind = 'opt_out')::bigint AS unique_opt_outs
          FROM activation_responses
          WHERE COALESCE(received_at, created_at) >= $1 AND category = $2`,
          [sinceIso, cat]
        ),
      ]);
      const catUd = Number(dr?.unique_dispatched) || 0;
      const catUr = Number(rr?.unique_responders) || 0;
      const catUo = Number(rr?.unique_opt_outs) || 0;
      return {
        category: cat,
        label: CATEGORY_LABELS[cat] || cat,
        total_dispatches: Number(dr?.total_dispatches) || 0,
        unique_dispatched: catUd,
        unique_responders: catUr,
        unique_opt_outs: catUo,
        response_rate: catUd > 0 ? catUr / catUd : 0,
        opt_out_rate: catUd > 0 ? catUo / catUd : 0,
      };
    })
  );
  byCatRows.sort((a, b) => b.response_rate - a.response_rate);

  // --- Top buttons ---
  const { rows: topButtons } = await query(
    `SELECT button_payload, COUNT(*)::int AS count
    FROM activation_responses
    WHERE COALESCE(received_at, created_at) >= $1
      AND button_payload IS NOT NULL
      ${respCatCond}
    GROUP BY button_payload
    ORDER BY count DESC
    LIMIT 5`,
    respParams
  );

  // --- Recent responses with pagination ---
  const limitIdx = respParams.length + 1;
  const offsetIdx = respParams.length + 2;

  const { rows: recentRows } = await query(
    `SELECT
      ar.id,
      ar.category,
      ar.master_key,
      ar.rgm,
      ar.response_kind,
      ar.button_payload,
      ar.message_text,
      ar.received_at,
      (
        SELECT de.nome
        FROM activation_dispatch_events de
        WHERE de.master_key = ar.master_key
          AND de.category = ar.category
          AND de.status = 'sent'
        ORDER BY de.created_at DESC
        LIMIT 1
      ) AS nome
    FROM activation_responses ar
    WHERE COALESCE(ar.received_at, ar.created_at) >= $1
      ${respCatCond}
    ORDER BY COALESCE(ar.received_at, ar.created_at) DESC
    LIMIT $${limitIdx} OFFSET $${offsetIdx}`,
    [...respParams, RECENT_LIMIT, offsetNum]
  );

  const { rows: [{ total_recent }] } = await query(
    `SELECT COUNT(*)::int AS total_recent
    FROM activation_responses
    WHERE COALESCE(received_at, created_at) >= $1
      ${respCatCond}`,
    respParams
  );

  return {
    filters: {
      category,
      period_days: periodDays,
      since: sinceIso,
      now: new Date().toISOString(),
    },
    kpis,
    by_category: byCatRows,
    top_buttons: topButtons.map((r) => ({
      button_payload: r.button_payload,
      count: r.count,
    })),
    recent_responses: recentRows.map((r) => ({
      id: r.id,
      category: r.category,
      master_key: r.master_key,
      rgm: r.rgm,
      nome: r.nome || null,
      response_kind: r.response_kind,
      button_payload: r.button_payload,
      message_text: r.message_text,
      received_at: r.received_at,
    })),
    total_recent: Number(total_recent) || 0,
    limit: RECENT_LIMIT,
    offset: offsetNum,
    generated_at: new Date().toISOString(),
  };
}
