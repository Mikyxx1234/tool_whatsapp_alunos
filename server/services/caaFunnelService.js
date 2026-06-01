import { query } from '../db/client.js';
import { calcJanela } from '../utils/caaWindow.js';
import * as journeySettingsRepo from '../repositories/journeySettingsRepository.js';

const CAP_DIARIO = 2;
const CAP_TOTAL = 4;

/**
 * Classifica o estado do funil para um protocolo.
 *
 * Prioridade: manual outcome > status do export.
 *
 * @param {object} p - protocolo enriquecido
 * @param {Date|null} expiresAt
 * @returns {string} estado
 */
function classifyEstado(p, expiresAt) {
  const hasManual = p.manual_outcome != null;

  if (hasManual) {
    return p.manual_outcome === 'revertido' ? 'revertido_manual' : 'perdido_manual';
  }

  const status = p.status;
  if (status === 'won_reverted') return 'revertido_export';
  if (status === 'lost_canceled' || status === 'lost_confirmed') return 'perdido_export';
  if (status === 'open') {
    const now = new Date();
    if (!expiresAt || expiresAt > now) return 'ativavel';
    return 'perdido_silencioso';
  }

  return 'unknown';
}

/**
 * Retorna o funil CAA calculado on-the-fly.
 *
 * @param {{
 *   estado?: string,
 *   engajado?: boolean,
 *   conflito?: boolean,
 *   limit?: number,
 *   offset?: number
 * }} opts
 */
export async function getCaaFunnel(opts = {}) {
  const settings = await journeySettingsRepo.getGlobal();
  const cfg = {
    caa_janela_t0: settings?.caa_janela_t0 ?? 'primeiro_export',
    caa_janela_dias_tipo: settings?.caa_janela_dias_tipo ?? 'corridos',
  };

  const now = new Date();

  // Carrega todos os protocolos com dados derivados em uma só query.
  // Base estoque acumulado: status='open' + últimos 30 dias + desfecho manual.
  const { rows } = await query(`
    WITH m_proto AS (
      SELECT DISTINCT ON (protocolo)
        protocolo, outcome, occurred_at, consultor_nome, motivo
      FROM activation_manual_outcomes
      WHERE category = 'processos-caa'
        AND protocolo IS NOT NULL
      ORDER BY protocolo, occurred_at DESC
    ),
    m_rgm AS (
      SELECT DISTINCT ON (rgm)
        rgm, outcome, occurred_at, consultor_nome, motivo
      FROM activation_manual_outcomes
      WHERE category = 'processos-caa'
        AND protocolo IS NULL
        AND rgm IS NOT NULL
      ORDER BY rgm, occurred_at DESC
    ),
    dispatches AS (
      SELECT
        master_key,
        COUNT(*)::int                                                AS dispatches_total,
        COUNT(*) FILTER (
          WHERE (created_at AT TIME ZONE 'America/Sao_Paulo')::date
              = (now() AT TIME ZONE 'America/Sao_Paulo')::date
        )::int                                                       AS dispatches_today,
        MIN(created_at)                                              AS first_dispatch_at
      FROM activation_dispatch_events
      WHERE category = 'processos-caa'
      GROUP BY master_key
    ),
    responses AS (
      SELECT DISTINCT ON (master_key)
        master_key,
        COALESCE(received_at, created_at) AS last_response_at,
        response_kind                      AS last_response_kind
      FROM activation_responses
      WHERE response_kind IN ('click', 'message')
      ORDER BY master_key, COALESCE(received_at, created_at) DESC NULLS LAST
    ),
    engagement AS (
      SELECT DISTINCT master_key
      FROM activation_responses
      WHERE response_kind IN ('click', 'message')
    )
    SELECT
      p.protocolo,
      p.rgm,
      p.cpf,
      p.nome,
      p.polo,
      p.curso,
      p.data_chegada,
      p.first_seen_at,
      p.last_seen_at,
      p.status,
      p.subprocesso,
      COALESCE(mp.outcome,       mr.outcome)       AS manual_outcome,
      COALESCE(mp.occurred_at,   mr.occurred_at)   AS manual_occurred_at,
      COALESCE(mp.consultor_nome,mr.consultor_nome) AS manual_consultor_nome,
      COALESCE(mp.motivo,        mr.motivo)         AS manual_motivo,
      COALESCE(d.dispatches_total,  0)::int         AS dispatches_total,
      COALESCE(d.dispatches_today, 0)::int          AS dispatches_today,
      d.first_dispatch_at,
      r.last_response_at,
      r.last_response_kind,
      (e.master_key IS NOT NULL)::boolean           AS engajado
    FROM caa_protocols p
    LEFT JOIN m_proto mp ON mp.protocolo = p.protocolo
    LEFT JOIN m_rgm   mr ON mr.rgm = p.rgm
    LEFT JOIN dispatches d ON d.master_key = 'RGM:' || p.rgm
    LEFT JOIN responses  r ON r.master_key = 'RGM:' || p.rgm
    LEFT JOIN engagement e ON e.master_key = 'RGM:' || p.rgm
    WHERE p.status = 'open'
       OR p.first_seen_at > NOW() - INTERVAL '30 days'
       OR EXISTS (
            SELECT 1 FROM activation_manual_outcomes amo
            WHERE amo.category = 'processos-caa'
              AND (amo.protocolo = p.protocolo OR amo.rgm = p.rgm)
          )
    ORDER BY p.status, p.first_seen_at ASC
  `);

  // Enriquece cada protocolo com janela e estado
  const processed = rows.map((p) => {
    const { t0, expires_at } = calcJanela(p, cfg);
    const estado = classifyEstado(p, expires_at);
    const horasRestantes =
      expires_at != null ? (expires_at.getTime() - now.getTime()) / 3600_000 : null;

    const conflito =
      (estado === 'revertido_manual' &&
        (p.status === 'lost_canceled' || p.status === 'lost_confirmed')) ||
      (estado === 'perdido_manual' && p.status === 'won_reverted');

    return {
      protocolo: p.protocolo,
      rgm: p.rgm ?? null,
      nome: p.nome ?? null,
      polo: p.polo ?? null,
      curso: p.curso ?? null,
      data_chegada: p.data_chegada ?? null,
      first_seen_at: p.first_seen_at ? new Date(p.first_seen_at).toISOString() : null,
      t0_at: t0 ? t0.toISOString() : null,
      expires_at: expires_at ? expires_at.toISOString() : null,
      horas_restantes: horasRestantes !== null ? Math.round(horasRestantes * 10) / 10 : null,
      status_export: p.status,
      manual_outcome: p.manual_outcome
        ? {
            outcome: p.manual_outcome,
            occurred_at: p.manual_occurred_at
              ? new Date(p.manual_occurred_at).toISOString()
              : null,
            consultor_nome: p.manual_consultor_nome ?? null,
            motivo: p.manual_motivo ?? null,
          }
        : null,
      estado,
      engajado: Boolean(p.engajado),
      conflito,
      dispatches_total: p.dispatches_total ?? 0,
      dispatches_today: p.dispatches_today ?? 0,
      last_response_at: p.last_response_at
        ? new Date(p.last_response_at).toISOString()
        : null,
      last_response_kind: p.last_response_kind ?? null,
    };
  });

  // Counts
  const counts = {
    ativavel: 0,
    perdido_silencioso: 0,
    revertido_manual: 0,
    perdido_manual: 0,
    revertido_export: 0,
    perdido_export: 0,
    unknown: 0,
    total_no_funil: 0,
    engajados: 0,
    com_conflito: 0,
  };

  for (const p of processed) {
    if (Object.prototype.hasOwnProperty.call(counts, p.estado)) {
      counts[p.estado]++;
    }
    if (p.estado !== 'unknown') counts.total_no_funil++;
    if (p.engajado && p.estado !== 'unknown') counts.engajados++;
    if (p.conflito) counts.com_conflito++;
  }

  // Aplica filtros
  let filtered = processed;
  if (opts.estado) {
    filtered = filtered.filter((p) => p.estado === opts.estado);
  }
  if (opts.engajado === true) {
    filtered = filtered.filter((p) => p.engajado);
  } else if (opts.engajado === false) {
    filtered = filtered.filter((p) => !p.engajado);
  }
  if (opts.conflito === true) {
    filtered = filtered.filter((p) => p.conflito);
  }

  const total_items = filtered.length;
  const limit = opts.limit ?? 50;
  const offset = opts.offset ?? 0;
  const items = filtered.slice(offset, offset + limit);

  return {
    config: {
      janela_t0: cfg.caa_janela_t0,
      janela_dias_tipo: cfg.caa_janela_dias_tipo,
      cap_diario: CAP_DIARIO,
      cap_total: CAP_TOTAL,
      now: now.toISOString(),
    },
    counts,
    items,
    total_items,
    limit,
    offset,
    generated_at: now.toISOString(),
  };
}
