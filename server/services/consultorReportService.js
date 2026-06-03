/**
 * consultorReportService.js
 *
 * Painel "Por consultor": cruza disparos × respostas × reversões CAA.
 *
 * Atribuição da reversão CAA: para cada caa_protocols.status='won_reverted',
 * encontra o último activation_dispatch_events.sent em CAA para o mesmo RGM,
 * dentro de uma janela (default 14 dias) antes do registro da reversão.
 *
 * "Perdido CAA" usa mesma regra com status='lost_canceled' ou 'lost_confirmed'.
 *
 * Forward-only: dispatches sem consultor_id (legados) caem no bucket "Sem consultor".
 *
 * Foco V1 = CAA (reversões + perdidos). Para outras categorias: só contagem de
 * disparos + respostas.
 */

import { query } from '../db/client.js';

const DEFAULT_PERIOD_DAYS = 30;
const DEFAULT_ATTRIBUTION_WINDOW_DAYS = 14;

const ALL_CATEGORIES = [
  'docs-pendentes',
  'financeiro',
  'provavel-evasao',
  'acessos-blackboard',
  'processos-caa',
  'aguardando-inicio',
];

const SEM_CONSULTOR_KEY = '__sem_consultor__';

function clampPeriod(days) {
  const n = Number(days);
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_PERIOD_DAYS;
  return Math.min(Math.max(Math.floor(n), 1), 365);
}

function consultorKey(id, nome) {
  if (id != null) return `id:${id}`;
  if (nome) return `nome:${String(nome).toLowerCase()}`;
  return SEM_CONSULTOR_KEY;
}

function consultorLabel(id, nome) {
  if (nome && id != null) return nome;
  if (nome) return nome;
  if (id != null) return `Consultor #${id}`;
  return 'Sem consultor';
}

/**
 * Relatório agregado por consultor.
 *
 * @param {object} opts
 * @param {number} [opts.periodDays=30] janela do período principal (dispatches/responses)
 * @param {string} [opts.category='all'] categoria específica ou 'all'
 * @param {number} [opts.attributionWindowDays=14] janela de atribuição de reversão CAA
 */
export async function getConsultorReport(opts = {}) {
  const periodDays = clampPeriod(opts.periodDays ?? DEFAULT_PERIOD_DAYS);
  const category = opts.category && opts.category !== 'all' ? opts.category : null;
  const attributionWindowDays = clampPeriod(
    opts.attributionWindowDays ?? DEFAULT_ATTRIBUTION_WINDOW_DAYS
  );

  const now = new Date();
  const since = new Date(now.getTime() - periodDays * 24 * 60 * 60 * 1000);

  // 1) Dispatches por consultor no período (todas as categorias se category=null)
  const dispatchSql = `
    SELECT
      consultor_id,
      consultor_nome,
      category,
      status,
      master_key,
      created_at
    FROM activation_dispatch_events
    WHERE created_at >= $1
      ${category ? 'AND category = $2' : ''}
  `;
  const dispatchParams = category ? [since, category] : [since];
  const { rows: dispatchRows } = await query(dispatchSql, dispatchParams);

  // Agrega por (consultor, categoria)
  // Map<consultorKey, { id, nome, label, categories: Map<cat, stats>, totals: stats }>
  const byConsultor = new Map();

  function ensureConsultor(id, nome) {
    const key = consultorKey(id, nome);
    if (!byConsultor.has(key)) {
      byConsultor.set(key, {
        key,
        id: id ?? null,
        nome: nome ?? null,
        label: consultorLabel(id, nome),
        totals: emptyStats(),
        by_category: Object.fromEntries(ALL_CATEGORIES.map((c) => [c, emptyStats()])),
      });
    }
    return byConsultor.get(key);
  }

  function emptyStats() {
    return {
      dispatches_sent: 0,
      dispatches_not_found: 0,
      dispatches_failed: 0,
      master_keys_sent: new Set(),
    };
  }

  for (const r of dispatchRows) {
    const c = ensureConsultor(r.consultor_id, r.consultor_nome);
    const cat = r.category;
    const catStats = c.by_category[cat] || (c.by_category[cat] = emptyStats());

    if (r.status === 'sent') {
      catStats.dispatches_sent += 1;
      c.totals.dispatches_sent += 1;
      if (r.master_key) {
        catStats.master_keys_sent.add(r.master_key);
        c.totals.master_keys_sent.add(r.master_key);
      }
    } else if (r.status === 'not_found') {
      catStats.dispatches_not_found += 1;
      c.totals.dispatches_not_found += 1;
    } else if (r.status === 'failed') {
      catStats.dispatches_failed += 1;
      c.totals.dispatches_failed += 1;
    }
  }

  // 2) Respostas (sent → respondeu): para cada master_key de cada consultor,
  // conta quantas tiveram resposta na janela do período
  // Como `activation_responses` não tem consultor_id, atribuímos pelo último
  // dispatch sent com consultor_id naquela (categoria, master_key) que antecedeu
  // a resposta. Filtro defensivo: response.received_at após dispatch e dentro de
  // 30 dias (janela larga pra não perder dados).
  const responseAttributionSql = `
    WITH resps AS (
      SELECT
        ar.id,
        ar.master_key,
        ar.category,
        coalesce(ar.received_at, ar.created_at) AS evt_at,
        ar.response_kind
      FROM activation_responses ar
      WHERE coalesce(ar.received_at, ar.created_at) >= $1
        AND ar.master_key IS NOT NULL
        ${category ? 'AND ar.category = $2' : ''}
    ),
    attributed AS (
      SELECT
        r.id AS resp_id,
        r.master_key,
        r.category,
        r.response_kind,
        (
          SELECT de.consultor_id
          FROM activation_dispatch_events de
          WHERE de.master_key = r.master_key
            AND de.category = r.category
            AND de.status = 'sent'
            AND de.created_at <= r.evt_at
            AND de.created_at >= r.evt_at - interval '30 days'
          ORDER BY de.created_at DESC
          LIMIT 1
        ) AS consultor_id,
        (
          SELECT de.consultor_nome
          FROM activation_dispatch_events de
          WHERE de.master_key = r.master_key
            AND de.category = r.category
            AND de.status = 'sent'
            AND de.created_at <= r.evt_at
            AND de.created_at >= r.evt_at - interval '30 days'
          ORDER BY de.created_at DESC
          LIMIT 1
        ) AS consultor_nome
      FROM resps r
    )
    SELECT
      consultor_id,
      consultor_nome,
      category,
      count(*) FILTER (WHERE response_kind IS NOT NULL) AS total_responses,
      count(DISTINCT master_key) AS unique_responders,
      count(DISTINCT master_key) FILTER (WHERE response_kind = 'click') AS unique_clickers,
      count(DISTINCT master_key) FILTER (WHERE response_kind = 'opt_out') AS unique_opt_outs
    FROM attributed
    GROUP BY consultor_id, consultor_nome, category
  `;
  const respParams = category ? [since, category] : [since];
  const { rows: respRows } = await query(responseAttributionSql, respParams);

  for (const r of respRows) {
    const c = ensureConsultor(r.consultor_id, r.consultor_nome);
    const cat = r.category;
    const catStats = c.by_category[cat] || (c.by_category[cat] = emptyStats());
    catStats.total_responses = Number(r.total_responses) || 0;
    catStats.unique_responders = Number(r.unique_responders) || 0;
    catStats.unique_clickers = Number(r.unique_clickers) || 0;
    catStats.unique_opt_outs = Number(r.unique_opt_outs) || 0;
    c.totals.total_responses = (c.totals.total_responses || 0) + (Number(r.total_responses) || 0);
    c.totals.unique_responders = (c.totals.unique_responders || 0) + (Number(r.unique_responders) || 0);
    c.totals.unique_clickers = (c.totals.unique_clickers || 0) + (Number(r.unique_clickers) || 0);
    c.totals.unique_opt_outs = (c.totals.unique_opt_outs || 0) + (Number(r.unique_opt_outs) || 0);
  }

  // 3) Reversão / perda CAA atribuída ao último dispatcher dentro da janela
  // Considera caa_protocols com status conclusivo (won_reverted | lost_*) cuja
  // last_seen_at caiu no período. O "último dispatcher" é o último
  // dispatch sent em CAA para esse RGM, dentro de attributionWindowDays antes
  // de last_seen_at.
  if (!category || category === 'processos-caa') {
    const caaSql = `
      WITH outcomes AS (
        SELECT
          cp.rgm,
          cp.status,
          cp.last_status_change_at AS outcome_at
        FROM caa_protocols cp
        WHERE cp.status IN ('won_reverted', 'lost_canceled', 'lost_confirmed')
          AND cp.last_status_change_at >= $1
          AND cp.rgm IS NOT NULL
      ),
      attributed AS (
        SELECT
          o.rgm,
          o.status,
          o.outcome_at,
          (
            SELECT de.consultor_id
            FROM activation_dispatch_events de
            WHERE de.category = 'processos-caa'
              AND de.status = 'sent'
              AND de.rgm = o.rgm
              AND de.created_at <= o.outcome_at
              AND de.created_at >= o.outcome_at - ($2::int * interval '1 day')
            ORDER BY de.created_at DESC
            LIMIT 1
          ) AS consultor_id,
          (
            SELECT de.consultor_nome
            FROM activation_dispatch_events de
            WHERE de.category = 'processos-caa'
              AND de.status = 'sent'
              AND de.rgm = o.rgm
              AND de.created_at <= o.outcome_at
              AND de.created_at >= o.outcome_at - ($2::int * interval '1 day')
            ORDER BY de.created_at DESC
            LIMIT 1
          ) AS consultor_nome
        FROM outcomes o
      )
      SELECT
        consultor_id,
        consultor_nome,
        count(*) FILTER (WHERE status = 'won_reverted') AS caa_revertidos,
        count(*) FILTER (WHERE status IN ('lost_canceled', 'lost_confirmed')) AS caa_perdidos
      FROM attributed
      GROUP BY consultor_id, consultor_nome
    `;
    const { rows: caaRows } = await query(caaSql, [since, attributionWindowDays]);

    for (const r of caaRows) {
      const c = ensureConsultor(r.consultor_id, r.consultor_nome);
      const caaCat = c.by_category['processos-caa'] || (c.by_category['processos-caa'] = emptyStats());
      caaCat.caa_revertidos = Number(r.caa_revertidos) || 0;
      caaCat.caa_perdidos = Number(r.caa_perdidos) || 0;
      c.totals.caa_revertidos = (c.totals.caa_revertidos || 0) + (Number(r.caa_revertidos) || 0);
      c.totals.caa_perdidos = (c.totals.caa_perdidos || 0) + (Number(r.caa_perdidos) || 0);
    }
  }

  // Serializa: converte Sets em counts, calcula taxas
  const consultores = [];
  for (const c of byConsultor.values()) {
    const totals = serializeStats(c.totals);
    const byCategory = {};
    for (const cat of ALL_CATEGORIES) {
      byCategory[cat] = serializeStats(c.by_category[cat]);
    }
    consultores.push({
      key: c.key,
      consultor_id: c.id,
      consultor_nome: c.nome,
      label: c.label,
      totals,
      by_category: byCategory,
    });
  }

  // Ordena: maior nº de envios primeiro; Sem consultor por último
  consultores.sort((a, b) => {
    if (a.key === SEM_CONSULTOR_KEY) return 1;
    if (b.key === SEM_CONSULTOR_KEY) return -1;
    return b.totals.dispatches_sent - a.totals.dispatches_sent;
  });

  return {
    filters: {
      period_days: periodDays,
      category: category || 'all',
      attribution_window_days: attributionWindowDays,
      since: since.toISOString(),
      now: now.toISOString(),
    },
    consultores,
    generated_at: now.toISOString(),
  };
}

function serializeStats(s) {
  if (!s) return {
    dispatches_sent: 0,
    dispatches_not_found: 0,
    dispatches_failed: 0,
    unique_recipients: 0,
    total_responses: 0,
    unique_responders: 0,
    unique_clickers: 0,
    unique_opt_outs: 0,
    response_rate: 0,
    caa_revertidos: 0,
    caa_perdidos: 0,
    caa_taxa_reversao: 0,
  };
  const unique = s.master_keys_sent instanceof Set ? s.master_keys_sent.size : 0;
  const resp = s.unique_responders || 0;
  const rev = s.caa_revertidos || 0;
  const perd = s.caa_perdidos || 0;
  return {
    dispatches_sent: s.dispatches_sent || 0,
    dispatches_not_found: s.dispatches_not_found || 0,
    dispatches_failed: s.dispatches_failed || 0,
    unique_recipients: unique,
    total_responses: s.total_responses || 0,
    unique_responders: resp,
    unique_clickers: s.unique_clickers || 0,
    unique_opt_outs: s.unique_opt_outs || 0,
    response_rate: unique > 0 ? Math.round((resp / unique) * 10000) / 100 : 0,
    caa_revertidos: rev,
    caa_perdidos: perd,
    caa_taxa_reversao: rev + perd > 0 ? Math.round((rev / (rev + perd)) * 10000) / 100 : 0,
  };
}
