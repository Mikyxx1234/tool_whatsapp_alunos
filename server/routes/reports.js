import { Router } from 'express';
import { isDbConfigured } from '../db/client.js';
import * as reportRepo from '../repositories/reportRepository.js';
import * as baseComparisonService from '../services/baseComparisonService.js';
import * as reportOverviewCache from '../services/reportOverviewCache.js';
import * as caaProtocolsRepo from '../repositories/caaProtocolsRepository.js';
import {
  countStatusInLatestSnapshot,
  getSnapshotPairDelta,
} from '../services/caaProtocolsService.js';
import { caaStatusLabel } from '../utils/caaRowFilters.js';
import { requireApiKey } from '../middleware/requireApiKey.js';
import { getCaaFunnel } from '../services/caaFunnelService.js';
import { getActivationConversion } from '../services/activationConversionService.js';
import { getConsultorReport } from '../services/consultorReportService.js';
import { getRgmToCicloMap, getAvailableCiclos } from '../services/cicloResolverService.js';

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function parseDateRange(fromRaw, toRaw) {
  const from = fromRaw && DATE_RE.test(String(fromRaw)) ? String(fromRaw) : null;
  const to = toRaw && DATE_RE.test(String(toRaw)) ? String(toRaw) : null;
  if (from && to && from > to) return { from: to, to: from };
  return { from, to };
}

const router = Router();

function handleError(res, err) {
  console.error('[reports]', err.message);
  res.status(err.status || 500).json({ error: err.message || 'Erro interno' });
}

function parseFilters(req) {
  return {
    term_id: req.query.term_id || undefined,
    polo: req.query.polo || undefined,
  };
}

async function resolveCaaSnapshotScope(req) {
  const scope = String(req.query.scope || 'last_snapshot').toLowerCase();
  if (scope === 'hours') {
    const hours = Math.max(1, Math.min(parseInt(req.query.hours, 10) || 24, 24 * 30));
    return { kind: 'hours', hours, since: new Date(Date.now() - hours * 3600 * 1000) };
  }
  const recent = await caaProtocolsRepo.listRecentSnapshots(2);
  const snap = recent[0] || null;
  const previous = recent[1] || null;
  return { kind: 'last_snapshot', snapshot: snap, previous_snapshot: previous };
}

router.get('/overview', async (req, res) => {
  try {
    if (!isDbConfigured()) {
      return res.status(503).json({ error: 'DATABASE_URL não configurada.' });
    }
    const { counts, count_hints } = await reportOverviewCache.getCachedOverview(() =>
      reportRepo.overviewFromSnapshots(parseFilters(req))
    );
    res.json({ counts, count_hints });
  } catch (err) {
    handleError(res, err);
  }
});

router.post('/overview/invalidate', requireApiKey, (_req, res) => {
  reportOverviewCache.invalidateOverviewCache();
  res.json({ ok: true });
});

router.post('/matriculados-comparison/invalidate', requireApiKey, (_req, res) => {
  reportOverviewCache.invalidateOverviewCache();
  baseComparisonService.invalidateComparisonCache();
  if (isDbConfigured()) {
    baseComparisonService.startComparisonBuildIfNeeded();
  }
  res.json({ ok: true });
});

router.get('/matriculados-comparison/status', (_req, res) => {
  try {
    if (!isDbConfigured()) {
      return res.status(503).json({ error: 'DATABASE_URL não configurada.' });
    }
    baseComparisonService.startComparisonBuildIfNeeded();
    const cached = baseComparisonService.getComparisonCacheMeta();
    res.json({
      ready: Boolean(cached),
      cached_at: cached?.cached_at ?? null,
      building: baseComparisonService.isComparisonBuilding(),
    });
  } catch (err) {
    handleError(res, err);
  }
});

router.get('/matriculados-comparison', async (_req, res) => {
  try {
    if (!isDbConfigured()) {
      return res.status(503).json({ error: 'DATABASE_URL não configurada.' });
    }
    const cached = baseComparisonService.getComparisonCacheMeta();
    if (cached) {
      const data = await baseComparisonService.buildMatriculadosComparison();
      return res.json(data);
    }
    baseComparisonService.startComparisonBuildIfNeeded();
    if (baseComparisonService.isComparisonBuilding()) {
      return res.status(202).json({ building: true });
    }
    const data = await baseComparisonService.buildMatriculadosComparison();
    if (baseComparisonService.getComparisonCacheMeta()) {
      return res.json(data);
    }
    return res.status(202).json({ building: true });
  } catch (err) {
    handleError(res, err);
  }
});

router.get('/caa/summary', async (req, res) => {
  try {
    if (!isDbConfigured()) {
      return res.status(503).json({ error: 'DATABASE_URL não configurada.' });
    }
    const scope = await resolveCaaSnapshotScope(req);
    const [available_ciclos, cicloMap] = await Promise.all([
      getAvailableCiclos(),
      getRgmToCicloMap(),
    ]);
    let stats;
    let needs_previous = false;
    let previous_snapshot = scope.kind === 'last_snapshot' ? scope.previous_snapshot : null;
    let identical_reimport = false;
    let used_stored_fallback = false;
    let summary_by_ciclo = undefined;
    if (scope.kind === 'hours') {
      stats = await caaProtocolsRepo.getDailyTransitionStats({ since: scope.since });
    } else if (!scope.snapshot) {
      stats = { novos_pendentes: 0, perdidos_canceled: 0, perdidos_confirmed: 0, revertidos: 0 };
    } else {
      const delta = await getSnapshotPairDelta({ cicloMap: available_ciclos.length > 1 ? cicloMap : undefined });
      stats = delta.stats;
      needs_previous = Boolean(delta.needs_previous);
      previous_snapshot = delta.previous ?? scope.previous_snapshot;
      identical_reimport = Boolean(delta.identical_reimport);
      used_stored_fallback = Boolean(delta.used_stored_fallback);
      summary_by_ciclo = delta.summary_by_ciclo;
    }
    const byStatus =
      scope.kind === 'last_snapshot'
        ? await countStatusInLatestSnapshot()
        : await caaProtocolsRepo.countByStatus();
    res.json({
      scope: scope.kind,
      window_hours: scope.kind === 'hours' ? scope.hours : null,
      since: scope.kind === 'hours' ? scope.since.toISOString() : null,
      snapshot: scope.kind === 'last_snapshot' ? scope.snapshot : null,
      previous_snapshot,
      needs_previous,
      identical_reimport,
      used_stored_fallback,
      transitions: stats,
      current: byStatus,
      labels: {
        open: caaStatusLabel('open'),
        lost_canceled: caaStatusLabel('lost_canceled'),
        lost_confirmed: caaStatusLabel('lost_confirmed'),
        won_reverted: caaStatusLabel('won_reverted'),
      },
      available_ciclos,
      summary_by_ciclo,
    });
  } catch (err) {
    handleError(res, err);
  }
});

router.get('/caa/transitions', async (req, res) => {
  try {
    if (!isDbConfigured()) {
      return res.status(503).json({ error: 'DATABASE_URL não configurada.' });
    }
    const scope = await resolveCaaSnapshotScope(req);
    const limit = Math.min(parseInt(req.query.limit, 10) || 200, 1000);
    const toStatus = req.query.to_status ? String(req.query.to_status).split(',') : undefined;
    const requireCurrentStatus =
      typeof req.query.current_status === 'string' && req.query.current_status
        ? String(req.query.current_status)
        : undefined;

    let rows = [];
    let total = 0;
    let needs_previous = false;
    let previous_snapshot = scope.kind === 'last_snapshot' ? scope.previous_snapshot : null;
    let identical_reimport = false;
    let used_stored_fallback = false;
    if (scope.kind === 'hours') {
      rows = await caaProtocolsRepo.listRecentTransitions({
        since: scope.since,
        toStatus,
        limit,
        requireCurrentStatus,
      });
      total = rows.length;
    } else if (scope.snapshot) {
      const delta = await getSnapshotPairDelta({ toStatus, limit, requireCurrentStatus });
      rows = delta.transitions;
      total = delta.total ?? rows.length;
      needs_previous = Boolean(delta.needs_previous);
      previous_snapshot = delta.previous ?? scope.previous_snapshot;
      identical_reimport = Boolean(delta.identical_reimport);
      used_stored_fallback = Boolean(delta.used_stored_fallback);
    }

    res.json({
      scope: scope.kind,
      since: scope.kind === 'hours' ? scope.since.toISOString() : null,
      snapshot: scope.kind === 'last_snapshot' ? scope.snapshot : null,
      previous_snapshot,
      needs_previous,
      identical_reimport,
      used_stored_fallback,
      total,
      items: rows,
    });
  } catch (err) {
    handleError(res, err);
  }
});

router.get('/caa/funnel', requireApiKey, async (req, res) => {
  try {
    if (!isDbConfigured()) {
      return res.status(503).json({ error: 'DATABASE_URL não configurada.' });
    }
    const estado = req.query.estado ? String(req.query.estado) : undefined;
    const limit = Math.min(parseInt(req.query.limit, 10) || 50, 500);
    const offset = Math.max(parseInt(req.query.offset, 10) || 0, 0);
    const ciclo = req.query.ciclo ? String(req.query.ciclo).trim() : undefined;

    let engajado;
    if (req.query.engajado === 'true') engajado = true;
    else if (req.query.engajado === 'false') engajado = false;

    const conflito = req.query.conflito === 'true' ? true : undefined;

    const result = await getCaaFunnel({ estado, engajado, conflito, limit, offset, ciclo });
    res.json(result);
  } catch (err) {
    handleError(res, err);
  }
});

router.get('/activation-conversion', requireApiKey, async (req, res) => {
  try {
    if (!isDbConfigured()) {
      return res.status(503).json({ error: 'DATABASE_URL não configurada.' });
    }
    const category = String(req.query.category || 'all');
    const period_days = Math.min(Math.max(parseInt(req.query.period_days, 10) || 30, 1), 365);
    const offset = Math.max(parseInt(req.query.offset, 10) || 0, 0);
    const ciclo = req.query.ciclo ? String(req.query.ciclo).trim() : null;
    const { from, to } = parseDateRange(req.query.from, req.query.to);
    const result = await getActivationConversion({ category, period_days, offset, ciclo, from, to });
    res.json(result);
  } catch (err) {
    handleError(res, err);
  }
});

router.get('/consultores', requireApiKey, async (req, res) => {
  try {
    if (!isDbConfigured()) {
      return res.status(503).json({ error: 'DATABASE_URL não configurada.' });
    }
    const periodDays = Math.min(Math.max(parseInt(req.query.period_days, 10) || 30, 1), 365);
    const result = await getConsultorReport({ periodDays });
    res.json(result);
  } catch (err) {
    handleError(res, err);
  }
});

router.get('/:type', async (req, res) => {
  try {
    const type = req.params.type;
    if (type === 'matriculados-comparison' || type === 'matriculados-comparison/status') {
      return res.status(404).json({
        error: 'Use GET /api/reports/matriculados-comparison ou /status',
      });
    }
    reportRepo.assertReportType(type);
    const limit = Math.min(parseInt(req.query.limit, 10) || 100, 500);
    const offset = parseInt(req.query.offset, 10) || 0;
    const [students, total] = await Promise.all([
      reportRepo.listReport(type, parseFilters(req), { limit, offset }),
      reportRepo.countReport(type, parseFilters(req)),
    ]);
    res.json({ students, total, type });
  } catch (err) {
    handleError(res, err);
  }
});

export default router;
