import { query } from '../db/client.js';
import { normalizeRgmCanonical } from '../utils/rgmDisplay.js';
import { parseFlexibleDate, excelSerialToDate } from '../utils/dateParser.js';

/** @typedef {'podia_e_nao_acessou'|'nao_acessa_faz_tempo'|'acessou_pouco'|'ok'} BbSubgrupo */

/**
 * Converte um valor de data flexível para Date.
 * Prioriza serial Excel, depois delega ao parser genérico.
 * @param {unknown} v
 * @returns {Date|null}
 */
function parseBbDate(v) {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  if (Number.isFinite(n) && n >= 20000 && n <= 80000) {
    return excelSerialToDate(n);
  }
  return parseFlexibleDate(v);
}

/**
 * Converte um valor para número inteiro, retornando 0 em caso de falha.
 * @param {unknown} v
 * @returns {number}
 */
function safeInt(v) {
  const n = parseInt(String(v ?? ''), 10);
  return Number.isFinite(n) && n >= 0 ? n : 0;
}

/**
 * Carrega o último snapshot de acessos_blackboard_rows e constrói um Map
 * keyed pelo RGM canônico.
 * @returns {Promise<Map<string, { ultimoAcesso: Date|null, minutos: number, interacoes: number }>>}
 */
export async function loadBbAccessMap() {
  const { rows: snapRows } = await query(
    `select id from acessos_blackboard_snapshots order by created_at desc limit 1`
  );
  if (!snapRows.length) return new Map();
  const snapId = snapRows[0].id;

  const { rows } = await query(
    `select data from acessos_blackboard_rows where snapshot_id = $1`,
    [snapId]
  );

  const map = new Map();
  for (const r of rows) {
    const d = r.data;
    if (!d || typeof d !== 'object') continue;
    const rgm = normalizeRgmCanonical(d['RGM'] ?? d['Rgm'] ?? d['rgm'] ?? '');
    if (!rgm) continue;
    const ultimoAcesso = parseBbDate(d['Ultimo Acesso'] ?? d['Último Acesso'] ?? d['UltimoAcesso'] ?? null);
    const minutos = safeInt(d['Minutos'] ?? d['minutos'] ?? 0);
    const interacoes = safeInt(d['Interações'] ?? d['Interacoes'] ?? d['interacoes'] ?? d['Interaçoes'] ?? 0);
    map.set(rgm, { ultimoAcesso, minutos, interacoes });
  }
  return map;
}

/**
 * Classifica um aluno no subgrupo BB.
 * @param {{
 *   accessRow: { ultimoAcesso: Date|null, minutos: number, interacoes: number }|null,
 *   thresholds: { bb_nao_acessa_dias: number, bb_acessou_pouco_minutos: number, bb_acessou_pouco_interacoes: number },
 *   today: Date,
 * }} params
 * @returns {BbSubgrupo}
 */
export function classifyBbSubgroup({ accessRow, thresholds, today }) {
  if (!accessRow) return 'podia_e_nao_acessou';
  if (!accessRow.ultimoAcesso) return 'podia_e_nao_acessou';

  const diffDays = Math.floor((today.getTime() - accessRow.ultimoAcesso.getTime()) / 86400000);
  if (diffDays >= thresholds.bb_nao_acessa_dias) return 'nao_acessa_faz_tempo';

  if (
    accessRow.minutos < thresholds.bb_acessou_pouco_minutos ||
    accessRow.interacoes < thresholds.bb_acessou_pouco_interacoes
  ) {
    return 'acessou_pouco';
  }

  return 'ok';
}
