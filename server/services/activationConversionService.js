import { query } from '../db/client.js';
import * as journeySettingsRepo from '../repositories/journeySettingsRepository.js';
import {
  getRgmToCicloMap,
  getAvailableCiclos,
  rgmFromMasterKey,
  masterKeysForCiclo,
} from './cicloResolverService.js';

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
 * Filtro defensivo: só conta respostas em `activation_responses` que tenham um
 * dispatch `sent` correspondente na mesma master_key/category nas últimas
 * `staleHours` antes do `received_at`. Sem isso, respostas tardias (3 meses
 * depois de uma ativação) virariam falso-positivo quando o campo
 * `origem_ativacao` no CRM não foi limpo (handshake n8n só limpa após a 1ª
 * resposta — decisão Opus 02/06/2026).
 *
 * O alias `r` deve apontar para `activation_responses`. O placeholder
 * `${staleHoursParamIdx}` é o índice (1-based) do parâmetro com a janela
 * em horas dentro do array de params da query.
 */
function buildValidResponseExists(rAlias, staleHoursParamIdx) {
  return `exists (
    select 1 from activation_dispatch_events d
    where d.master_key = ${rAlias}.master_key
      and d.category = ${rAlias}.category
      and d.status = 'sent'
      and d.created_at <= coalesce(${rAlias}.received_at, ${rAlias}.created_at)
      and d.created_at >= coalesce(${rAlias}.received_at, ${rAlias}.created_at) - ($${staleHoursParamIdx}::int * interval '1 hour')
  )`;
}

/**
 * @param {{ category?: string, period_days?: number, offset?: number, ciclo?: string }} opts
 */
export async function getActivationConversion({ category = 'all', period_days = 30, offset = 0, ciclo = null } = {}) {
  const periodDays = Math.min(Math.max(Number(period_days) || 30, 1), 365);
  const offsetNum = Math.max(Number(offset) || 0, 0);
  const sinceDate = new Date(Date.now() - periodDays * 24 * 60 * 60 * 1000);
  const sinceIso = sinceDate.toISOString();
  const catFilter = category !== 'all' ? category : null;

  const settings = await journeySettingsRepo.resolveForTerm(null);
  const staleHours = Math.max(
    1,
    Math.floor(Number(settings?.origem_ativacao_stale_hours) || 72)
  );

  // Ciclo resolution
  const available_ciclos = await getAvailableCiclos();
  const hasCiclos = available_ciclos.length > 1;
  const cicloMap = hasCiclos ? await getRgmToCicloMap() : new Map();

  // When a specific ciclo is requested, build an array of matching master_keys
  // so we can add AND master_key = ANY($N) to all queries.
  const activeCiclo = (ciclo && available_ciclos.includes(ciclo)) ? ciclo : null;
  const cicloMasterKeys = activeCiclo ? masterKeysForCiclo(cicloMap, activeCiclo) : null;

  // Build param arrays and conditions, with optional ciclo master_key filter.
  function buildDispParams(base) {
    if (cicloMasterKeys) return [...base, cicloMasterKeys];
    return base;
  }
  function buildDispCond(baseCond, baseLen) {
    if (cicloMasterKeys) return `${baseCond} AND master_key = ANY($${baseLen + 1})`;
    return baseCond;
  }

  const dispBaseParams = catFilter ? [sinceIso, catFilter] : [sinceIso];
  const dispBaseCond = catFilter ? 'AND category = $2' : '';
  const dispParams = buildDispParams(dispBaseParams);
  const dispCatCond = buildDispCond(dispBaseCond, dispBaseParams.length);

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

  // --- KPIs from responses (com filtro defensivo) ---
  const respKpiBaseParams = catFilter ? [sinceIso, catFilter, staleHours] : [sinceIso, staleHours];
  const respKpiCatCond = catFilter ? 'AND r.category = $2' : '';
  const respKpiStaleIdx = catFilter ? 3 : 2;
  const validResponseExistsR = buildValidResponseExists('r', respKpiStaleIdx);
  const respKpiParams = cicloMasterKeys
    ? [...respKpiBaseParams, cicloMasterKeys]
    : respKpiBaseParams;
  const respKpiCicloCond = cicloMasterKeys
    ? `AND r.master_key = ANY($${respKpiBaseParams.length + 1})`
    : '';

  const { rows: [rk] } = await query(
    `SELECT
      COUNT(DISTINCT r.master_key) FILTER (WHERE r.master_key IS NOT NULL)::bigint AS unique_responders,
      COUNT(DISTINCT r.master_key) FILTER (WHERE r.master_key IS NOT NULL AND r.response_kind = 'click')::bigint AS unique_clickers,
      COUNT(DISTINCT r.master_key) FILTER (WHERE r.master_key IS NOT NULL AND r.response_kind = 'message')::bigint AS unique_messages,
      COUNT(DISTINCT r.master_key) FILTER (WHERE r.master_key IS NOT NULL AND r.response_kind = 'opt_out')::bigint AS unique_opt_outs
    FROM activation_responses r
    WHERE COALESCE(r.received_at, r.created_at) >= $1
      ${respKpiCatCond}
      ${respKpiCicloCond}
      AND ${validResponseExistsR}`,
    respKpiParams
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
  const byCatValidExists = buildValidResponseExists('r', 3);
  const byCatRows = await Promise.all(
    ALL_CATEGORIES.map(async (cat) => {
      const byCatDispParams = cicloMasterKeys ? [sinceIso, cat, cicloMasterKeys] : [sinceIso, cat];
      const byCatRespParams = cicloMasterKeys ? [sinceIso, cat, staleHours, cicloMasterKeys] : [sinceIso, cat, staleHours];
      const byCatCicloCond = cicloMasterKeys ? `AND master_key = ANY($${4})` : '';
      const byCatRespCicloCond = cicloMasterKeys ? `AND r.master_key = ANY($${4})` : '';
      const byCatRespValidExists = buildValidResponseExists('r', 3);

      const [{ rows: [dr] }, { rows: [rr] }] = await Promise.all([
        query(
          `SELECT
            COUNT(*)::bigint AS total_dispatches,
            COUNT(DISTINCT master_key) FILTER (WHERE master_key IS NOT NULL)::bigint AS unique_dispatched
          FROM activation_dispatch_events
          WHERE status = 'sent' AND created_at >= $1 AND category = $2 ${byCatCicloCond}`,
          byCatDispParams
        ),
        query(
          `SELECT
            COUNT(DISTINCT r.master_key) FILTER (WHERE r.master_key IS NOT NULL)::bigint AS unique_responders,
            COUNT(DISTINCT r.master_key) FILTER (WHERE r.master_key IS NOT NULL AND r.response_kind = 'opt_out')::bigint AS unique_opt_outs
          FROM activation_responses r
          WHERE COALESCE(r.received_at, r.created_at) >= $1
            AND r.category = $2
            ${byCatRespCicloCond}
            AND ${byCatRespValidExists}`,
          byCatRespParams
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

  // --- Top buttons (com filtro defensivo) ---
  const topBtnBaseParams = catFilter ? [sinceIso, catFilter, staleHours] : [sinceIso, staleHours];
  const topBtnCatCond = catFilter ? 'AND r.category = $2' : '';
  const topBtnStaleIdx = catFilter ? 3 : 2;
  const topBtnValidExists = buildValidResponseExists('r', topBtnStaleIdx);
  const topBtnParams = cicloMasterKeys
    ? [...topBtnBaseParams, cicloMasterKeys]
    : topBtnBaseParams;
  const topBtnCicloCond = cicloMasterKeys
    ? `AND r.master_key = ANY($${topBtnBaseParams.length + 1})`
    : '';

  const { rows: topButtons } = await query(
    `SELECT r.button_payload, COUNT(*)::int AS count
    FROM activation_responses r
    WHERE COALESCE(r.received_at, r.created_at) >= $1
      AND r.button_payload IS NOT NULL
      ${topBtnCatCond}
      ${topBtnCicloCond}
      AND ${topBtnValidExists}
    GROUP BY r.button_payload
    ORDER BY count DESC
    LIMIT 5`,
    topBtnParams
  );

  // --- Recent responses with pagination (com filtro defensivo) ---
  const recentBaseParams = catFilter ? [sinceIso, catFilter, staleHours] : [sinceIso, staleHours];
  const recentCatCond = catFilter ? 'AND ar.category = $2' : '';
  const recentStaleIdx = catFilter ? 3 : 2;
  const recentValidExists = buildValidResponseExists('ar', recentStaleIdx);
  const recentParams = cicloMasterKeys
    ? [...recentBaseParams, cicloMasterKeys]
    : recentBaseParams;
  const recentCicloCond = cicloMasterKeys
    ? `AND ar.master_key = ANY($${recentBaseParams.length + 1})`
    : '';
  const recentLimitIdx = recentParams.length + 1;
  const recentOffsetIdx = recentParams.length + 2;

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
      ${recentCatCond}
      ${recentCicloCond}
      AND ${recentValidExists}
    ORDER BY COALESCE(ar.received_at, ar.created_at) DESC
    LIMIT $${recentLimitIdx} OFFSET $${recentOffsetIdx}`,
    [...recentParams, RECENT_LIMIT, offsetNum]
  );

  // --- Total recent ---
  const totalRecentValidExists = buildValidResponseExists('r', recentStaleIdx);
  const totalRecentCicloCond = cicloMasterKeys
    ? `AND r.master_key = ANY($${recentBaseParams.length + 1})`
    : '';
  const { rows: [{ total_recent }] } = await query(
    `SELECT COUNT(*)::int AS total_recent
    FROM activation_responses r
    WHERE COALESCE(r.received_at, r.created_at) >= $1
      ${catFilter ? 'AND r.category = $2' : ''}
      ${totalRecentCicloCond}
      AND ${totalRecentValidExists}`,
    recentParams
  );

  // --- kpis_by_ciclo ---
  /** @type {Record<string, object>} */
  let kpis_by_ciclo = {};
  if (hasCiclos) {
    // Pull raw dispatch master_keys (with count) to group by ciclo
    const rawDispAllParams = catFilter ? [sinceIso, catFilter] : [sinceIso];
    const rawDispAllCatCond = catFilter ? 'AND category = $2' : '';
    const { rows: rawDispAllRows } = await query(
      `SELECT master_key FROM activation_dispatch_events
       WHERE status = 'sent' AND created_at >= $1 ${rawDispAllCatCond}`,
      rawDispAllParams
    );

    // Pull raw response master_keys with response_kind
    const rawRespAllBaseParams = catFilter ? [sinceIso, catFilter, staleHours] : [sinceIso, staleHours];
    const rawRespAllCatCond = catFilter ? 'AND r.category = $2' : '';
    const rawRespAllStaleIdx = catFilter ? 3 : 2;
    const rawRespAllValidExists = buildValidResponseExists('r', rawRespAllStaleIdx);
    const { rows: rawRespAllRows } = await query(
      `SELECT r.master_key, r.response_kind FROM activation_responses r
       WHERE COALESCE(r.received_at, r.created_at) >= $1
         ${rawRespAllCatCond}
         AND ${rawRespAllValidExists}`,
      rawRespAllBaseParams
    );

    for (const cicloKey of available_ciclos) {
      let totalDisp = 0;
      const dispSet = new Set();
      for (const { master_key } of rawDispAllRows) {
        const rgm = rgmFromMasterKey(master_key);
        if (rgm && cicloMap.get(rgm) === cicloKey) {
          totalDisp++;
          dispSet.add(master_key);
        }
      }
      const respMap = new Map();
      for (const { master_key, response_kind } of rawRespAllRows) {
        const rgm = rgmFromMasterKey(master_key);
        if (!rgm || cicloMap.get(rgm) !== cicloKey) continue;
        if (!respMap.has(master_key)) respMap.set(master_key, new Set());
        respMap.get(master_key).add(response_kind);
      }
      const cicloCud = dispSet.size;
      const cicloCur = respMap.size;
      const cicloUco = [...respMap.values()].filter((s) => s.has('click')).length;
      const cicloUmo = [...respMap.values()].filter((s) => s.has('message')).length;
      const cicloUoo = [...respMap.values()].filter((s) => s.has('opt_out')).length;
      kpis_by_ciclo[cicloKey] = {
        total_dispatches: totalDisp,
        unique_dispatched: cicloCud,
        unique_responders: cicloCur,
        unique_clickers: cicloUco,
        unique_messages: cicloUmo,
        unique_opt_outs: cicloUoo,
        response_rate: cicloCud > 0 ? cicloCur / cicloCud : 0,
        opt_out_rate: cicloCud > 0 ? cicloUoo / cicloCud : 0,
      };
    }
  }

  return {
    filters: {
      category,
      period_days: periodDays,
      since: sinceIso,
      now: new Date().toISOString(),
      stale_window_hours: staleHours,
      ciclo: activeCiclo,
    },
    kpis,
    kpis_by_ciclo,
    available_ciclos,
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
