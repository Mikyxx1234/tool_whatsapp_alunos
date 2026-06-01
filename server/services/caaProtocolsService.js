import { query } from '../db/client.js';
import { isCaaCancelamentoSolicitacao } from '../utils/caaRowFilters.js';
import {
  protocolFromRow,
  upsertProtocolsWithTransitions,
  listRecentSnapshots,
} from '../repositories/caaProtocolsRepository.js';

/**
 * Carrega todos os protocolos com status='open' da tabela acumulada, dedupados por RGM.
 * Fonte de verdade do estoque acumulado de pendentes.
 */
async function loadOpenProtocolsFromTable() {
  const { rows } = await query(
    `select distinct on (coalesce(rgm, protocolo))
       protocolo, rgm, cpf, nome, email, telefone, polo, curso, instituicao,
       subprocesso, data_chegada, data_previsao, data_conclusao,
       situacao_atendimento_raw, situacao_deferimento_raw, status,
       last_status_change_at, first_seen_at
     from caa_protocols
     where status = 'open'
     order by coalesce(rgm, protocolo), last_status_change_at desc`
  );
  return rows;
}

/**
 * Mapa protocolo → dados normalizados de um snapshot (só cancelamento de matrícula).
 * @param {string} snapshotId
 */
async function loadCancelamentoMap(snapshotId) {
  const { rows } = await query(
    `select data from processos_caa_rows where snapshot_id = $1`,
    [snapshotId]
  );
  /** @type {Map<string, ReturnType<typeof protocolFromRow>>} */
  const map = new Map();
  for (const r of rows) {
    if (!isCaaCancelamentoSolicitacao(r.data)) continue;
    const input = protocolFromRow(r.data);
    if (!input) continue;
    map.set(input.protocolo, input);
  }
  return map;
}

/**
 * Diff entre dois exports: status no último vs penúltimo (D+1 real).
 * @param {Map<string, ReturnType<typeof protocolFromRow>>} prevMap
 * @param {Map<string, ReturnType<typeof protocolFromRow>>} latestMap
 * @param {string} changedAtIso
 */
function diffSnapshotMaps(prevMap, latestMap, changedAtIso) {
  /** @type {Array<Record<string, unknown>>} */
  const out = [];
  for (const [protocolo, latest] of latestMap) {
    const prev = prevMap.get(protocolo);
    const fromStatus = prev?.status ?? null;
    const toStatus = latest.status;
    if (fromStatus === toStatus) continue;
    out.push({
      protocolo,
      rgm: latest.rgm,
      from_status: fromStatus,
      to_status: toStatus,
      current_status: toStatus,
      changed_at: changedAtIso,
      nome: latest.nome,
      email: latest.email,
      telefone: latest.telefone,
      polo: latest.polo,
      curso: latest.curso,
      subprocesso: latest.subprocesso,
      data_chegada: latest.data_chegada,
      data_previsao: latest.data_previsao,
      data_conclusao: latest.data_conclusao,
      situacao_atendimento_raw: latest.situacao_atendimento_raw,
      situacao_deferimento_raw: latest.situacao_deferimento_raw,
    });
  }
  return out;
}

function aggregateTransitionStats(transitions) {
  const list = /** @type {{ from_status: string|null, to_status: string, current_status: string }[]} */ (
    transitions
  );
  return {
    novos_pendentes: list.filter(
      (t) => t.to_status === 'open' && t.from_status === null && t.current_status === 'open'
    ).length,
    perdidos_canceled: list.filter(
      (t) => t.from_status === 'open' && t.to_status === 'lost_canceled'
    ).length,
    perdidos_confirmed: list.filter(
      (t) => t.from_status === 'open' && t.to_status === 'lost_confirmed'
    ).length,
    revertidos: list.filter(
      (t) => t.from_status === 'open' && t.to_status === 'won_reverted'
    ).length,
  };
}

/** Dedup 1 linha por RGM (mesma regra da fila de ativação CAA). */
function dedupOpenByRgm(protocols) {
  const seen = new Set();
  const out = [];
  for (const p of protocols) {
    const key = (p.rgm && String(p.rgm).trim()) || p.protocolo;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(p);
  }
  return out;
}

function openProtocolsFromMap(latestMap) {
  return dedupOpenByRgm([...latestMap.values()].filter((p) => p.status === 'open'));
}

/** Linha no formato da tabela do painel. */
function protocolToPanelRow(p, changedAtIso) {
  return {
    protocolo: p.protocolo,
    rgm: p.rgm,
    from_status: null,
    to_status: 'open',
    current_status: 'open',
    changed_at: changedAtIso,
    nome: p.nome,
    email: p.email,
    telefone: p.telefone,
    polo: p.polo,
    curso: p.curso,
    subprocesso: p.subprocesso,
    data_chegada: p.data_chegada,
    data_previsao: p.data_previsao,
    data_conclusao: p.data_conclusao,
    situacao_atendimento_raw: p.situacao_atendimento_raw,
    situacao_deferimento_raw: p.situacao_deferimento_raw,
    em_fila_ativacao: true,
  };
}

/** Perdidos/revertidos: só transições D+1 (pendente → desfecho). */
function filterTransitionsForTab(transitions, opts = {}) {
  const toStatuses = Array.isArray(opts.toStatus)
    ? opts.toStatus
    : opts.toStatus
      ? [opts.toStatus]
      : null;
  if (!toStatuses?.length) {
    return transitions.filter((t) => t.from_status === 'open');
  }
  if (toStatuses.includes('open')) {
    return [];
  }
  return transitions.filter((t) => t.from_status === 'open' && toStatuses.includes(t.to_status));
}

function isNovosPendentesTab(opts = {}) {
  const toStatuses = Array.isArray(opts.toStatus)
    ? opts.toStatus
    : opts.toStatus
      ? [opts.toStatus]
      : [];
  return toStatuses.includes('open') && opts.requireCurrentStatus === 'open';
}

/**
 * KPIs e lista D+1: compara último export com o anterior (linhas brutas dos snapshots).
 * @param {{ toStatus?: string[], limit?: number, requireCurrentStatus?: string }} [opts]
 */
export async function getSnapshotPairDelta(opts = {}) {
  const snaps = await listRecentSnapshots(2);
  const latest = snaps[0] || null;
  const previous = snaps[1] || null;
  if (!latest) {
    return { latest: null, previous: null, transitions: [], stats: aggregateTransitionStats([]) };
  }
  if (!previous) {
    return {
      latest,
      previous: null,
      transitions: [],
      stats: aggregateTransitionStats([]),
      needs_previous: true,
    };
  }

  const [prevMap, latestMap, openRows] = await Promise.all([
    loadCancelamentoMap(previous.id),
    loadCancelamentoMap(latest.id),
    loadOpenProtocolsFromTable(),
  ]);
  const changedAt =
    latest.created_at instanceof Date
      ? latest.created_at.toISOString()
      : new Date(latest.created_at).toISOString();
  const allDiff = diffSnapshotMaps(prevMap, latestMap, changedAt);
  const stats = aggregateTransitionStats(allDiff);
  stats.novos_pendentes = openRows.length;
  stats.novos_pendentes_no_diff = allDiff.filter(
    (t) => t.from_status === null && t.to_status === 'open'
  ).length;

  let transitions;
  if (isNovosPendentesTab(opts)) {
    transitions = openRows.map((p) => protocolToPanelRow(p, changedAt));
  } else {
    transitions = filterTransitionsForTab(allDiff, opts);
  }

  const limit = opts.limit ?? 500;
  transitions.sort((a, b) => String(b.changed_at).localeCompare(String(a.changed_at)));
  const limited = transitions.slice(0, limit);

  const identical_reimport =
    stats.perdidos_canceled === 0 &&
    stats.perdidos_confirmed === 0 &&
    stats.revertidos === 0 &&
    stats.novos_pendentes_no_diff === 0 &&
    previous.row_count === latest.row_count &&
    previous.file_name === latest.file_name;

  return {
    latest,
    previous,
    transitions: limited,
    stats,
    total: transitions.length,
    used_stored_fallback: false,
    identical_reimport,
    open_in_latest: openRows.length,
  };
}

/**
 * Contagem por status no último export (com reparo de colunas deslocadas).
 */
export async function countStatusInLatestSnapshot() {
  const snaps = await listRecentSnapshots(1);
  const latest = snaps[0];
  /** @type {Record<string, number>} */
  const out = { open: 0, lost_canceled: 0, lost_confirmed: 0, won_reverted: 0, unknown: 0 };
  if (!latest) return out;
  const map = await loadCancelamentoMap(latest.id);
  for (const p of map.values()) {
    const s = p?.status || 'unknown';
    out[s] = (out[s] || 0) + 1;
  }
  return out;
}

/**
 * Processa todas as linhas de um snapshot CAA recém-importado:
 * - Mantém só protocolos com Subprocesso = CANCELAMENTO DE MATRÍCULA
 * - UPSERT em caa_protocols
 * - Grava transições quando status normalizado mudou (D+1)
 *
 * Idempotente: chamar 2x com o mesmo snapshotId não duplica transições
 * porque a transição só é registrada quando o status REALMENTE muda em relação
 * ao estado vivo da tabela (não em relação a snapshots passados).
 *
 * @param {string} snapshotId
 */
export async function processSnapshot(snapshotId) {
  const { rows } = await query(
    `select data from processos_caa_rows where snapshot_id = $1`,
    [snapshotId]
  );

  /** @type {ReturnType<typeof protocolFromRow>[]} */
  const inputs = [];
  for (const r of rows) {
    if (!isCaaCancelamentoSolicitacao(r.data)) continue;
    const input = protocolFromRow(r.data);
    if (!input) continue;
    inputs.push(input);
  }

  const stats = await upsertProtocolsWithTransitions(inputs, snapshotId);
  console.log(
    `[caa-protocols] snapshot ${snapshotId}: ${stats.total} cancelamentos, ${stats.new_protocols} novos, ${stats.status_changed} mudanças de status`
  );
  return stats;
}
