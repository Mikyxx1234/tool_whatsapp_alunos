import * as baseUploadRepo from '../repositories/baseUploadRepository.js';
import * as trackingRepo from '../repositories/rematriculaTrackingRepository.js';
import { getIntersectionActivationList } from './activationService.js';
import {
  isRematriculaEmCursoRow,
  rematFinanceiroSubgrupoFromRow,
  REMAT_CICLO_DESTINO,
} from '../utils/rematriculaEligibility.js';
import { normalizeRgmCanonical } from '../utils/rgmDisplay.js';
import { normalizeCiclo } from '../utils/cicloFromRow.js';
import {
  dataMatriculaDateKey,
  isMatriculadosRematriculaRow,
} from '../utils/matriculadosTipoMatricula.js';

const BRT = 'America/Sao_Paulo';

/** @returns {string} YYYY-MM-DD */
export function todayStatDateBrt() {
  return new Date().toLocaleDateString('en-CA', { timeZone: BRT });
}

/**
 * @param {Record<string, unknown>} row
 */
function identityKeyFromRow(row) {
  const rgm = normalizeRgmCanonical(
    String(row.RGM_ALUN ?? row.RGM ?? row['RGM Aluno'] ?? '')
  );
  if (rgm) return `rgm:${rgm}`;
  const cpf = String(row.CPF_ALUN ?? row.CPF ?? '').replace(/\D/g, '');
  if (cpf.length >= 11) return `cpf:${cpf.slice(-11)}`;
  return '';
}

/**
 * @param {string} snapshotId
 * @returns {Promise<Map<string, 'adimplente'|'inadimplente'>>}
 */
async function buildFinancialMap(snapshotId) {
  /** @type {Map<string, 'adimplente'|'inadimplente'>} */
  const map = new Map();
  await baseUploadRepo.forEachRowDataForSnapshot('rematricula', snapshotId, (row) => {
    if (!isRematriculaEmCursoRow(row)) return;
    const key = identityKeyFromRow(row);
    if (!key) return;
    map.set(key, rematFinanceiroSubgrupoFromRow(row));
  });
  return map;
}

/**
 * @param {string|null|undefined} prevSnapId
 * @param {string} currSnapId
 */
export async function compareSnapshotFinancialMaps(prevSnapId, currSnapId) {
  if (!prevSnapId || prevSnapId === currSnapId) {
    return {
      novos_inadimplentes: 0,
      recuperados_financeiro: 0,
      novos_na_base: 0,
      sairam_da_base: 0,
    };
  }
  const [prevMap, currMap] = await Promise.all([
    buildFinancialMap(prevSnapId),
    buildFinancialMap(currSnapId),
  ]);

  let novos_inadimplentes = 0;
  let recuperados_financeiro = 0;
  let novos_na_base = 0;
  let sairam_da_base = 0;

  for (const [key, fin] of currMap.entries()) {
    const prevFin = prevMap.get(key);
    if (!prevFin) {
      novos_na_base += 1;
      if (fin === 'inadimplente') novos_inadimplentes += 1;
      continue;
    }
    if (prevFin === 'adimplente' && fin === 'inadimplente') novos_inadimplentes += 1;
    if (prevFin === 'inadimplente' && fin === 'adimplente') recuperados_financeiro += 1;
  }

  for (const key of prevMap.keys()) {
    if (!currMap.has(key)) sairam_da_base += 1;
  }

  return { novos_inadimplentes, recuperados_financeiro, novos_na_base, sairam_da_base };
}

/**
 * @param {{ reason?: string, statDate?: string, force?: boolean }} [opts]
 */
export async function captureRematriculaDailyPoint(opts = {}) {
  const snap = await baseUploadRepo.getLatestSnapshot('rematricula');
  if (!snap) return null;

  const list = await getIntersectionActivationList('rematricula');
  const counts = list.remat_subgrupo_counts ?? { adimplente: 0, inadimplente: 0 };
  const total = list.total ?? 0;
  const adimplente = counts.adimplente ?? 0;
  const inadimplente = counts.inadimplente ?? 0;
  const pct_inadimplente = total > 0 ? Math.round((inadimplente / total) * 10000) / 100 : 0;

  const stat_date = opts.statDate || todayStatDateBrt();
  const prev = await trackingRepo.getPreviousStatBefore(stat_date);
  const existingToday = await trackingRepo.getStatByDate(stat_date);

  if (
    !opts.force &&
    existingToday &&
    existingToday.snapshot_id === snap.id &&
    existingToday.total_em_curso === total &&
    existingToday.inadimplente === inadimplente
  ) {
    return existingToday;
  }

  const prevSnapForDiff = existingToday?.snapshot_id || prev?.snapshot_id || null;
  const diff = await compareSnapshotFinancialMaps(prevSnapForDiff, snap.id);

  const delta_total = prev ? total - (prev.total_em_curso ?? 0) : null;
  const delta_adimplente = prev ? adimplente - (prev.adimplente ?? 0) : null;
  const delta_inadimplente = prev ? inadimplente - (prev.inadimplente ?? 0) : null;

  const ativacoes_dia = await trackingRepo.countActivationsOnDate(stat_date);

  return trackingRepo.upsertDailyStat({
    stat_date,
    snapshot_id: snap.id,
    source: snap.source ?? null,
    total_em_curso: total,
    adimplente,
    inadimplente,
    pct_inadimplente,
    delta_total,
    delta_adimplente,
    delta_inadimplente,
    novos_inadimplentes: diff.novos_inadimplentes,
    recuperados_financeiro: diff.recuperados_financeiro,
    sairam_da_base: diff.sairam_da_base,
    ativacoes_dia,
    capture_reason: opts.reason || 'scheduled',
  });
}

function _parseIsoDate(v) {
  const s = String(v || '').trim().slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : null;
}

function _periodBounds(opts) {
  if (opts.from && opts.to) return { from: opts.from, to: opts.to };
  const days = Math.min(Math.max(Number(opts.days) || 30, 1), 365);
  const to = todayStatDateBrt();
  const end = new Date(`${to}T12:00:00`);
  const start = new Date(end);
  start.setDate(start.getDate() - (days - 1));
  return {
    from: start.toLocaleDateString('en-CA', { timeZone: BRT }),
    to,
  };
}

/**
 * Conta rematrículas no snapshot matriculados (tipo_matricula), alinhado ao Dashboard Acadêmico.
 * @param {{ ciclo?: string, from?: string|null, to?: string|null, days?: number }} [opts]
 */
export async function countMatriculadosRematriculas(opts = {}) {
  const snap = await baseUploadRepo.getLatestSnapshot('matriculados');
  if (!snap) {
    return { total: 0, hoje: 0, periodo: 0, ciclo: REMAT_CICLO_DESTINO, snapshot: null };
  }

  const cicloNorm = normalizeCiclo(opts.ciclo || REMAT_CICLO_DESTINO);
  const today = todayStatDateBrt();
  const { from, to } = _periodBounds(opts);

  let total = 0;
  let hoje = 0;
  let periodo = 0;

  await baseUploadRepo.forEachRowDataForSnapshot('matriculados', snap.id, (row) => {
    if (!isMatriculadosRematriculaRow(row, cicloNorm)) return;
    total += 1;
    const dk = dataMatriculaDateKey(row);
    if (dk === today) hoje += 1;
    if (dk && dk >= from && dk <= to) periodo += 1;
  });

  return {
    total,
    hoje,
    periodo,
    ciclo: cicloNorm,
    snapshot: {
      id: snap.id,
      file_name: snap.file_name,
      row_count: snap.row_count,
      created_at: snap.created_at,
    },
  };
}

function _kpisFromRow(row, activations_period, rematCounts) {
  return {
    total_em_curso: row.total_em_curso,
    adimplente: row.adimplente,
    inadimplente: row.inadimplente,
    pct_inadimplente: Number(row.pct_inadimplente ?? 0),
    delta_total: row.delta_total,
    delta_inadimplente: row.delta_inadimplente,
    delta_adimplente: row.delta_adimplente,
    ativacoes_hoje: row.ativacoes_dia,
    ativacoes_periodo: activations_period,
    novos_inadimplentes: row.novos_inadimplentes ?? 0,
    recuperados: row.recuperados_financeiro ?? 0,
    rematriculas_acumuladas: rematCounts.total,
    rematriculas_hoje: rematCounts.hoje,
    rematriculas_periodo: rematCounts.periodo,
    rematriculas_ciclo: rematCounts.ciclo,
  };
}

/**
 * @param {{ days?: number, capture?: boolean, date?: string, from?: string, to?: string }} [opts]
 */
export async function getRematriculaTrackingDashboard(opts = {}) {
  const days = Math.min(Math.max(Number(opts.days) || 30, 7), 365);
  const focusDate = _parseIsoDate(opts.date);
  const rangeFrom = _parseIsoDate(opts.from);
  const rangeTo = _parseIsoDate(opts.to);

  let series;
  if (rangeFrom && rangeTo && rangeFrom <= rangeTo) {
    series = await trackingRepo.listDailyStatsBetween(rangeFrom, rangeTo);
  } else {
    series = await trackingRepo.listDailyStats(days);
  }

  if (!series.length || opts.capture) {
    await captureRematriculaDailyPoint({ reason: opts.capture ? 'manual' : 'on_demand' });
    if (rangeFrom && rangeTo && rangeFrom <= rangeTo) {
      series = await trackingRepo.listDailyStatsBetween(rangeFrom, rangeTo);
    } else {
      series = await trackingRepo.listDailyStats(days);
    }
  }

  if (focusDate) {
    const has = series.some((s) => String(s.stat_date).slice(0, 10) === focusDate);
    if (!has) {
      const row = await trackingRepo.getStatByDate(focusDate);
      if (row) {
        series = [...series, row].sort((a, b) =>
          String(a.stat_date).localeCompare(String(b.stat_date))
        );
      }
    }
  }

  const latest = series[series.length - 1] || null;
  const prev = series.length > 1 ? series[series.length - 2] : null;

  const snap = await baseUploadRepo.getLatestSnapshot('rematricula');
  let activations_series;
  if (rangeFrom && rangeTo && rangeFrom <= rangeTo) {
    activations_series = await trackingRepo.activationsByDayBetween(rangeFrom, rangeTo);
  } else {
    activations_series = await trackingRepo.activationsByDay(days);
  }

  const list = snap ? await getIntersectionActivationList('rematricula') : null;
  const live = list
    ? {
        total: list.total,
        adimplente: list.remat_subgrupo_counts?.adimplente ?? 0,
        inadimplente: list.remat_subgrupo_counts?.inadimplente ?? 0,
        pct_inadimplente:
          list.total > 0
            ? Math.round(((list.remat_subgrupo_counts?.inadimplente ?? 0) / list.total) * 10000) /
              100
            : 0,
      }
    : null;

  let upload_diff = null;
  if (snap && series.length) {
    const lastWithSnap = [...series].reverse().find((s) => s.snapshot_id && s.snapshot_id !== snap.id);
    if (lastWithSnap?.snapshot_id) {
      upload_diff = await compareSnapshotFinancialMaps(lastWithSnap.snapshot_id, snap.id);
      upload_diff.from_snapshot_at = lastWithSnap.captured_at;
    }
  }

  const totalActivations = activations_series.reduce((a, r) => a + (r.n ?? 0), 0);
  const activationsToday =
    activations_series.find((r) => String(r.day).slice(0, 10) === todayStatDateBrt())?.n ?? 0;

  let focusRow = null;
  if (focusDate) {
    focusRow =
      series.find((s) => String(s.stat_date).slice(0, 10) === focusDate) ||
      (await trackingRepo.getStatByDate(focusDate));
  }

  const currentTotal = live?.total ?? latest?.total_em_curso ?? 0;

  const rematCounts = await countMatriculadosRematriculas({
    from: rangeFrom,
    to: rangeTo,
    days: rangeFrom && rangeTo ? undefined : days,
  });

  let kpis;
  if (focusDate) {
    kpis = focusRow
      ? _kpisFromRow(focusRow, totalActivations, rematCounts)
      : {
          total_em_curso: 0,
          adimplente: 0,
          inadimplente: 0,
          pct_inadimplente: 0,
          delta_total: null,
          delta_inadimplente: null,
          delta_adimplente: null,
          ativacoes_hoje: 0,
          ativacoes_periodo: totalActivations,
          novos_inadimplentes: 0,
          recuperados: 0,
          rematriculas_acumuladas: rematCounts.total,
          rematriculas_hoje: rematCounts.hoje,
          rematriculas_periodo: rematCounts.periodo,
          rematriculas_ciclo: rematCounts.ciclo,
        };
  } else {
    kpis = {
      total_em_curso: currentTotal,
      adimplente: live?.adimplente ?? latest?.adimplente ?? 0,
      inadimplente: live?.inadimplente ?? latest?.inadimplente ?? 0,
      pct_inadimplente: live?.pct_inadimplente ?? Number(latest?.pct_inadimplente ?? 0),
      delta_total: latest?.delta_total ?? null,
      delta_inadimplente: latest?.delta_inadimplente ?? null,
      delta_adimplente: latest?.delta_adimplente ?? null,
      ativacoes_hoje: activationsToday,
      ativacoes_periodo: totalActivations,
      novos_inadimplentes: latest?.novos_inadimplentes ?? upload_diff?.novos_inadimplentes ?? 0,
      recuperados: latest?.recuperados_financeiro ?? upload_diff?.recuperados_financeiro ?? 0,
      rematriculas_acumuladas: rematCounts.total,
      rematriculas_hoje: rematCounts.hoje,
      rematriculas_periodo: rematCounts.periodo,
      rematriculas_ciclo: rematCounts.ciclo,
    };
  }

  return {
    live,
    latest,
    previous: prev,
    series,
    activations_series,
    focus_date: focusDate,
    focus_found: focusDate ? Boolean(focusRow) : null,
    filter: {
      days: rangeFrom && rangeTo ? null : days,
      from: rangeFrom,
      to: rangeTo,
    },
    snapshot: snap
      ? {
          id: snap.id,
          file_name: snap.file_name,
          row_count: snap.row_count,
          created_at: snap.created_at,
          source: snap.source,
        }
      : null,
    upload_diff,
    matriculados_snapshot: rematCounts.snapshot,
    kpis,
    generated_at: new Date().toISOString(),
  };
}
