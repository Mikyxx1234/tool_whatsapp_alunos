import { query } from '../db/client.js';
import * as journeySettingsRepo from '../repositories/journeySettingsRepository.js';
import {
  normalizeOrigemAtivacaoFilter,
  sqlOrigemAtivacaoCond,
  sqlOutcomeLinkedToResponseExists,
  isOrigemMovimentacaoInterna,
} from '../utils/origemAtivacaoFilter.js';
import {
  getRgmToCicloMap,
  getAvailableCiclos,
  rgmFromMasterKey,
  masterKeysForCiclo,
} from './cicloResolverService.js';
import * as frozenCyclesRepo from '../repositories/frozenCyclesRepository.js';

const CATEGORY_LABELS = {
  'docs-pendentes': 'Docs pendentes',
  financeiro: 'Financeiro',
  'acessos-blackboard': 'Sem acesso BB',
  'processos-caa': 'Processos CAA',
  'provavel-evasao': 'Provável evasão',
  'aguardando-inicio': 'Aguardando início',
  'conteudo-previo': 'Conteúdo prévio',
  rematricula: 'Rematrícula',
};

const ALL_CATEGORIES = Object.keys(CATEGORY_LABELS);
const RECENT_LIMIT = 50;

/**
 * Filtro defensivo + atribuição temporal: conta respostas em
 * `activation_responses` que tenham um dispatch `sent` correspondente na mesma
 * master_key/category nas últimas `staleHours` antes do `received_at`, E cujo
 * dispatch caia DENTRO do período pedido (`dispSinceParamIdx`/`dispUntilParamIdx`).
 *
 * Decisão 10/06/2026: respostas agregam pelo dia do disparo correspondente,
 * não pelo dia da resposta. Sem isso, respostas tardias entrariam no dia errado.
 *
 * Decisão original 02/06/2026 (filtro `staleHours`): sem essa janela, respostas
 * 3 meses depois de uma ativação virariam falso-positivo quando o campo
 * `origem_ativacao` no CRM não foi limpo (handshake n8n só limpa após a 1ª resposta).
 *
 * @param {string} rAlias                 alias de `activation_responses` (ex: 'r', 'ar')
 * @param {number} staleHoursParamIdx     índice 1-based do param da janela em horas
 * @param {number|null} dispSinceParamIdx índice 1-based do param de sinceIso (filtro lower do dispatch)
 * @param {number|null} dispUntilParamIdx índice 1-based do param de untilIso (filtro upper do dispatch)
 */
function buildValidResponseExists(rAlias, staleHoursParamIdx, dispSinceParamIdx = null, dispUntilParamIdx = null) {
  const dispSinceCond = dispSinceParamIdx
    ? `\n      and d.created_at >= $${dispSinceParamIdx}`
    : '';
  const dispUntilCond = dispUntilParamIdx
    ? `\n      and d.created_at < $${dispUntilParamIdx}`
    : '';
  return `exists (
    select 1 from activation_dispatch_events d
    where d.master_key = ${rAlias}.master_key
      and d.category = ${rAlias}.category
      and d.status = 'sent'
      and d.created_at <= coalesce(${rAlias}.received_at, ${rAlias}.created_at)
      and d.created_at >= coalesce(${rAlias}.received_at, ${rAlias}.created_at) - ($${staleHoursParamIdx}::int * interval '1 hour')${dispSinceCond}${dispUntilCond}
  )`;
}

/**
 * @param {{ category?: string, period_days?: number, offset?: number, ciclo?: string, from?: string|null, to?: string|null, origem_ativacao?: string|null }} opts
 */
export async function getActivationConversion({ category = 'all', period_days = 30, offset = 0, ciclo = null, from = null, to = null, origem_ativacao = null } = {}) {
  const periodDays = Math.min(Math.max(Number(period_days) || 30, 1), 365);
  const offsetNum = Math.max(Number(offset) || 0, 0);
  const origemFilter = normalizeOrigemAtivacaoFilter(origem_ativacao);
  const skipWhatsappMetrics = isOrigemMovimentacaoInterna(origemFilter);
  const origemRespCond = sqlOrigemAtivacaoCond('r', origemFilter);
  // ATM/IA: sem disparo WhatsApp — não cruzar dispatch_events com responses da origem.
  const origemDispCond = skipWhatsappMetrics
    ? 'AND false'
    : origemFilter
      ? `AND EXISTS (
        SELECT 1 FROM activation_responses r
        WHERE r.master_key = activation_dispatch_events.master_key
          AND r.category = activation_dispatch_events.category
          ${sqlOrigemAtivacaoCond('r', origemFilter)}
      )`
      : '';
  const origemRevCond = origemFilter
    ? `AND ${sqlOutcomeLinkedToResponseExists('activation_manual_outcomes', origemFilter)}`
    : '';

  let sinceIso;
  let untilIso = null;
  if (from || to) {
    sinceIso = from ? new Date(from + 'T00:00:00.000Z').toISOString() : '1970-01-01T00:00:00.000Z';
    if (to) {
      const untilDate = new Date(to + 'T00:00:00.000Z');
      untilDate.setDate(untilDate.getDate() + 1);
      untilIso = untilDate.toISOString();
    }
  } else {
    sinceIso = new Date(Date.now() - periodDays * 24 * 60 * 60 * 1000).toISOString();
  }
  const catFilter = category !== 'all' ? category : null;

  const settings = await journeySettingsRepo.resolveForTerm(null);
  const staleHours = Math.max(
    1,
    Math.floor(Number(settings?.origem_ativacao_stale_hours) || 72)
  );

  // Ciclo resolution — excluir ciclos frozen do dropdown e dos kpis_by_ciclo.
  const [availableCiclosRaw, frozenSetConv] = await Promise.all([
    getAvailableCiclos(),
    frozenCyclesRepo.getFrozenSet(),
  ]);
  const available_ciclos = availableCiclosRaw.filter((c) => !frozenSetConv.has(c));
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

  function withUntil(params, colExpr) {
    if (!untilIso) return { params, cond: '' };
    return { params: [...params, untilIso], cond: `AND ${colExpr} < $${params.length + 1}` };
  }

  /**
   * Versão de withUntil pra colunas de RESPOSTAS (`r.received_at`): relaxa o
   * upper bound em `staleHours` pra cobrir respostas tardias dentro da janela
   * E adiciona o `untilIso` ORIGINAL pra ser usado no EXISTS (filtro no
   * `d.created_at` original do dispatch).
   * Decisão 10/06/2026 — respostas atribuídas ao dia do dispatch correspondente.
   *
   * @returns {{ params: any[], cond: string, dispUntilIdx: number|null }}
   *   - cond: filtro em r.received_at (com upper bound estendido)
   *   - dispUntilIdx: índice (1-based) do untilIso ORIGINAL nos params (pra passar pro EXISTS)
   */
  function withUntilForResponses(params, colExpr) {
    if (!untilIso) return { params, cond: '', dispUntilIdx: null };
    const untilExtended = new Date(new Date(untilIso).getTime() + staleHours * 3600 * 1000).toISOString();
    // Adiciona DOIS params: untilExtended (filtro r.received_at) e untilIso ORIGINAL (filtro EXISTS).
    const newParams = [...params, untilExtended, untilIso];
    return {
      params: newParams,
      cond: `AND ${colExpr} < $${params.length + 1}`,
      dispUntilIdx: params.length + 2,
    };
  }

  const dispBaseParams = catFilter ? [sinceIso, catFilter] : [sinceIso];
  const dispBaseCond = catFilter ? 'AND category = $2' : '';
  const dispParamsPreUntil = buildDispParams(dispBaseParams);
  const dispCatCond = buildDispCond(dispBaseCond, dispBaseParams.length);
  const { params: dispParams, cond: dispUntilCond } = withUntil(dispParamsPreUntil, 'created_at');

  // --- KPIs from dispatches ---
  const { rows: [dk] } = await query(
    `SELECT
      COUNT(*)::bigint AS total_dispatches,
      COUNT(DISTINCT master_key) FILTER (WHERE master_key IS NOT NULL)::bigint AS unique_dispatched
    FROM activation_dispatch_events
    WHERE status = 'sent'
      AND created_at >= $1
      ${dispCatCond}
      ${dispUntilCond}
      ${origemDispCond}`,
    dispParams
  );

  // --- KPIs from responses (com filtro defensivo + atribuição ao dia do disparo) ---
  const respKpiBaseParams = catFilter ? [sinceIso, catFilter, staleHours] : [sinceIso, staleHours];
  const respKpiCatCond = catFilter ? 'AND r.category = $2' : '';
  const respKpiStaleIdx = catFilter ? 3 : 2;
  const respKpiParamsPreUntil = cicloMasterKeys
    ? [...respKpiBaseParams, cicloMasterKeys]
    : respKpiBaseParams;
  const respKpiCicloCond = cicloMasterKeys
    ? `AND r.master_key = ANY($${respKpiBaseParams.length + 1})`
    : '';
  const { params: respKpiParams, cond: respKpiUntilCond, dispUntilIdx: respKpiDispUntilIdx } =
    withUntilForResponses(respKpiParamsPreUntil, 'COALESCE(r.received_at, r.created_at)');
  const validResponseExistsR = buildValidResponseExists('r', respKpiStaleIdx, 1, respKpiDispUntilIdx);

  const rk = skipWhatsappMetrics
    ? { unique_responders: 0, unique_clickers: 0, unique_messages: 0, unique_opt_outs: 0 }
    : (await query(
      `SELECT
      COUNT(DISTINCT r.master_key) FILTER (WHERE r.master_key IS NOT NULL)::bigint AS unique_responders,
      COUNT(DISTINCT r.master_key) FILTER (WHERE r.master_key IS NOT NULL AND r.response_kind = 'click')::bigint AS unique_clickers,
      COUNT(DISTINCT r.master_key) FILTER (WHERE r.master_key IS NOT NULL AND r.response_kind = 'message')::bigint AS unique_messages,
      COUNT(DISTINCT r.master_key) FILTER (WHERE r.master_key IS NOT NULL AND r.response_kind = 'opt_out')::bigint AS unique_opt_outs
    FROM activation_responses r
    WHERE COALESCE(r.received_at, r.created_at) >= $1
      ${respKpiCatCond}
      ${respKpiCicloCond}
      ${respKpiUntilCond}
      ${origemRespCond}
      AND ${validResponseExistsR}`,
      respKpiParams
    )).rows[0];

  const ud = Number(dk.unique_dispatched) || 0;
  const ur = Number(rk.unique_responders) || 0;
  const uc = Number(rk.unique_clickers) || 0;
  const um = Number(rk.unique_messages) || 0;
  const uo = Number(rk.unique_opt_outs) || 0;
  const dispDenom = skipWhatsappMetrics ? 0 : (ud > 0 ? ud : (origemFilter ? ur : 0));

  // --- KPI de revertidos (marcações manuais do Meu Painel) ---
  // activation_manual_outcomes tem master_key (text, nullable) — usa DISTINCT master_key
  const rkBaseParams = catFilter ? [sinceIso, catFilter] : [sinceIso];
  const rkCatCond = catFilter ? 'AND category = $2' : '';
  const rkParamsPreCiclo = cicloMasterKeys ? [...rkBaseParams, cicloMasterKeys] : rkBaseParams;
  const rkCicloCond = cicloMasterKeys
    ? `AND master_key = ANY($${rkBaseParams.length + 1})`
    : '';
  const { params: rkParams, cond: rkUntilCond } = withUntil(rkParamsPreCiclo, 'occurred_at');

  const { rows: [rev] } = await query(
    `SELECT COUNT(DISTINCT master_key) FILTER (WHERE master_key IS NOT NULL)::bigint AS unique_reverted
       FROM activation_manual_outcomes
      WHERE outcome = 'revertido'
        AND occurred_at >= $1
        ${rkCatCond}
        ${rkCicloCond}
        ${rkUntilCond}
        ${origemRevCond}`,
    rkParams
  );

  const kpis = {
    total_dispatches: Number(dk.total_dispatches) || 0,
    unique_dispatched: ud,
    unique_responders: ur,
    unique_clickers: uc,
    unique_messages: um,
    unique_opt_outs: uo,
    unique_reverted: Number(rev?.unique_reverted ?? 0),
    response_rate: dispDenom > 0 ? ur / dispDenom : 0,
    opt_out_rate: dispDenom > 0 ? uo / dispDenom : 0,
    whatsapp_metrics: !skipWhatsappMetrics,
  };

  // --- by_category: revertidos pre-fetched via GROUP BY (single query for all 6 cats) ---
  const revByCatBaseParams = [sinceIso];
  const revByCatParamsPreCiclo = cicloMasterKeys ? [...revByCatBaseParams, cicloMasterKeys] : revByCatBaseParams;
  const revByCatCicloCond = cicloMasterKeys ? `AND master_key = ANY($2)` : '';
  const { params: revByCatParams, cond: revByCatUntilCond } = withUntil(revByCatParamsPreCiclo, 'occurred_at');
  const { rows: revByCatRows } = await query(
    `SELECT category,
            COUNT(DISTINCT master_key) FILTER (WHERE master_key IS NOT NULL)::bigint AS unique_reverted
       FROM activation_manual_outcomes
      WHERE outcome = 'revertido'
        AND occurred_at >= $1
        ${revByCatCicloCond}
        ${revByCatUntilCond}
      GROUP BY category`,
    revByCatParams
  );
  const revByCatMap = new Map(revByCatRows.map((r) => [r.category, Number(r.unique_reverted) || 0]));

  // --- by_category: always computed for all categories ---
  const byCatRows = await Promise.all(
    ALL_CATEGORIES.map(async (cat) => {
      const byCatDispBase = cicloMasterKeys ? [sinceIso, cat, cicloMasterKeys] : [sinceIso, cat];
      const byCatRespBase = cicloMasterKeys ? [sinceIso, cat, staleHours, cicloMasterKeys] : [sinceIso, cat, staleHours];
      const byCatDispCicloCond = cicloMasterKeys ? `AND master_key = ANY($3)` : '';
      const byCatRespCicloCond = cicloMasterKeys ? `AND r.master_key = ANY($4)` : '';
      const { params: byCatDispParams, cond: byCatDispUntilCond } = withUntil(byCatDispBase, 'created_at');
      const { params: byCatRespParams, cond: byCatRespUntilCond, dispUntilIdx: byCatDispUntilIdx } =
        withUntilForResponses(byCatRespBase, 'COALESCE(r.received_at, r.created_at)');
      const byCatRespValidExists = buildValidResponseExists('r', 3, 1, byCatDispUntilIdx);

      const [{ rows: [dr] }, { rows: [rr] }] = await Promise.all([
        query(
          `SELECT
            COUNT(*)::bigint AS total_dispatches,
            COUNT(DISTINCT master_key) FILTER (WHERE master_key IS NOT NULL)::bigint AS unique_dispatched
          FROM activation_dispatch_events
          WHERE status = 'sent' AND created_at >= $1 AND category = $2 ${byCatDispCicloCond} ${byCatDispUntilCond}`,
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
            ${byCatRespUntilCond}
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
        unique_reverted: revByCatMap.get(cat) ?? 0,
        response_rate: catUd > 0 ? catUr / catUd : 0,
        opt_out_rate: catUd > 0 ? catUo / catUd : 0,
      };
    })
  );
  byCatRows.sort((a, b) => b.response_rate - a.response_rate);

  // --- Top buttons (com filtro defensivo + atribuição ao dia do disparo) ---
  const topBtnBaseParams = catFilter ? [sinceIso, catFilter, staleHours] : [sinceIso, staleHours];
  const topBtnCatCond = catFilter ? 'AND r.category = $2' : '';
  const topBtnStaleIdx = catFilter ? 3 : 2;
  const topBtnParamsPreUntil = cicloMasterKeys
    ? [...topBtnBaseParams, cicloMasterKeys]
    : topBtnBaseParams;
  const topBtnCicloCond = cicloMasterKeys
    ? `AND r.master_key = ANY($${topBtnBaseParams.length + 1})`
    : '';
  const { params: topBtnParams, cond: topBtnUntilCond, dispUntilIdx: topBtnDispUntilIdx } =
    withUntilForResponses(topBtnParamsPreUntil, 'COALESCE(r.received_at, r.created_at)');
  const topBtnValidExists = buildValidResponseExists('r', topBtnStaleIdx, 1, topBtnDispUntilIdx);

  const { rows: topButtons } = await query(
    `SELECT r.button_payload, COUNT(*)::int AS count
    FROM activation_responses r
    WHERE COALESCE(r.received_at, r.created_at) >= $1
      AND r.button_payload IS NOT NULL
      ${topBtnCatCond}
      ${topBtnCicloCond}
      ${topBtnUntilCond}
      AND ${topBtnValidExists}
    GROUP BY r.button_payload
    ORDER BY count DESC
    LIMIT 5`,
    topBtnParams
  );

  // --- Recent responses with pagination (com filtro defensivo + atribuição ao dia do disparo) ---
  const recentBaseParams = catFilter ? [sinceIso, catFilter, staleHours] : [sinceIso, staleHours];
  const recentCatCond = catFilter ? 'AND ar.category = $2' : '';
  const recentStaleIdx = catFilter ? 3 : 2;
  const recentParamsPreUntil = cicloMasterKeys
    ? [...recentBaseParams, cicloMasterKeys]
    : recentBaseParams;
  const recentCicloCond = cicloMasterKeys
    ? `AND ar.master_key = ANY($${recentBaseParams.length + 1})`
    : '';
  const { params: recentParams, cond: recentUntilCond, dispUntilIdx: recentDispUntilIdx } =
    withUntilForResponses(recentParamsPreUntil, 'COALESCE(ar.received_at, ar.created_at)');
  const recentValidExists = buildValidResponseExists('ar', recentStaleIdx, 1, recentDispUntilIdx);
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
      ${recentUntilCond}
      AND ${recentValidExists}
    ORDER BY COALESCE(ar.received_at, ar.created_at) DESC
    LIMIT $${recentLimitIdx} OFFSET $${recentOffsetIdx}`,
    [...recentParams, RECENT_LIMIT, offsetNum]
  );

  // --- Total recent ---
  const totalRecentCicloCond = cicloMasterKeys
    ? `AND r.master_key = ANY($${recentBaseParams.length + 1})`
    : '';
  const { params: totalRecentParams, cond: totalRecentUntilCond, dispUntilIdx: totalRecentDispUntilIdx } =
    withUntilForResponses(recentParamsPreUntil, 'COALESCE(r.received_at, r.created_at)');
  const totalRecentValidExists = buildValidResponseExists('r', recentStaleIdx, 1, totalRecentDispUntilIdx);
  const totalRecentCatCond = catFilter ? 'AND r.category = $2' : '';
  const { rows: [{ total_recent }] } = await query(
    `SELECT COUNT(*)::int AS total_recent
    FROM activation_responses r
    WHERE COALESCE(r.received_at, r.created_at) >= $1
      ${totalRecentCatCond}
      ${totalRecentCicloCond}
      ${totalRecentUntilCond}
      AND ${totalRecentValidExists}`,
    totalRecentParams
  );

  // --- kpis_by_ciclo ---
  /** @type {Record<string, object>} */
  let kpis_by_ciclo = {};
  if (hasCiclos) {
    // Pull raw dispatch master_keys (with count) to group by ciclo
    const rawDispAllBaseParams = catFilter ? [sinceIso, catFilter] : [sinceIso];
    const rawDispAllCatCond = catFilter ? 'AND category = $2' : '';
    const { params: rawDispAllParams, cond: rawDispAllUntilCond } = withUntil(rawDispAllBaseParams, 'created_at');
    const { rows: rawDispAllRows } = await query(
      `SELECT master_key FROM activation_dispatch_events
       WHERE status = 'sent' AND created_at >= $1 ${rawDispAllCatCond} ${rawDispAllUntilCond}`,
      rawDispAllParams
    );

    // Pull raw reverted master_keys for kpis_by_ciclo grouping
    const rawRevAllBaseParams = catFilter ? [sinceIso, catFilter] : [sinceIso];
    const rawRevAllCatCond = catFilter ? 'AND category = $2' : '';
    const { params: rawRevAllParams, cond: rawRevAllUntilCond } = withUntil(rawRevAllBaseParams, 'occurred_at');
    const { rows: rawRevAllRows } = await query(
      `SELECT master_key FROM activation_manual_outcomes
       WHERE outcome = 'revertido' AND occurred_at >= $1 AND master_key IS NOT NULL
         ${rawRevAllCatCond} ${rawRevAllUntilCond}`,
      rawRevAllParams
    );

    // Pull raw response master_keys with response_kind (atribuição ao dia do disparo)
    const rawRespAllBaseParams = catFilter ? [sinceIso, catFilter, staleHours] : [sinceIso, staleHours];
    const rawRespAllCatCond = catFilter ? 'AND r.category = $2' : '';
    const rawRespAllStaleIdx = catFilter ? 3 : 2;
    const { params: rawRespAllParams, cond: rawRespAllUntilCond, dispUntilIdx: rawRespAllDispUntilIdx } =
      withUntilForResponses(rawRespAllBaseParams, 'COALESCE(r.received_at, r.created_at)');
    const rawRespAllValidExists = buildValidResponseExists('r', rawRespAllStaleIdx, 1, rawRespAllDispUntilIdx);
    const { rows: rawRespAllRows } = await query(
      `SELECT r.master_key, r.response_kind FROM activation_responses r
       WHERE COALESCE(r.received_at, r.created_at) >= $1
         ${rawRespAllCatCond}
         ${rawRespAllUntilCond}
         AND ${rawRespAllValidExists}`,
      rawRespAllParams
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
      const revSet = new Set();
      for (const { master_key } of rawRevAllRows) {
        const rgm = rgmFromMasterKey(master_key);
        if (rgm && cicloMap.get(rgm) === cicloKey) revSet.add(master_key);
      }
      kpis_by_ciclo[cicloKey] = {
        total_dispatches: totalDisp,
        unique_dispatched: cicloCud,
        unique_responders: cicloCur,
        unique_clickers: cicloUco,
        unique_messages: cicloUmo,
        unique_opt_outs: cicloUoo,
        unique_reverted: revSet.size,
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
      until: untilIso ?? undefined,
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
