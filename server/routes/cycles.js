import { Router } from 'express';
import { isDbConfigured } from '../db/client.js';
import { requireApiKey } from '../middleware/requireApiKey.js';
import * as frozenCyclesRepo from '../repositories/frozenCyclesRepository.js';
import * as cicloResolverService from '../services/cicloResolverService.js';

const router = Router();

/**
 * GET /api/cycles
 * Lista ciclos disponíveis (via matriculados atuais) cruzado com status (ativo/arquivado).
 * Inclui também ciclos frozen que não estão mais no snapshot atual — pra que o operador
 * possa visualizar o histórico e reativar se precisar.
 *
 * Response: { cycles: [{ ciclo, status: 'active'|'frozen', frozen_at?, frozen_by?, reason? }] }
 */
router.get('/', async (req, res, next) => {
  try {
    if (!isDbConfigured()) {
      return res.status(503).json({ error: 'DATABASE_URL não configurada.' });
    }
    const [available, frozen] = await Promise.all([
      cicloResolverService.getAvailableCiclos(),
      frozenCyclesRepo.listFrozen(),
    ]);
    const frozenMap = new Map(frozen.map((f) => [f.ciclo, f]));
    // União de ciclos disponíveis no snapshot e ciclos frozen (histórico).
    const allCiclos = new Set([...available, ...frozen.map((f) => f.ciclo)]);
    const cycles = [...allCiclos]
      .sort((a, b) => b.localeCompare(a))
      .map((ciclo) => {
        const f = frozenMap.get(ciclo);
        if (f) {
          return {
            ciclo,
            status: 'frozen',
            frozen_at: f.frozen_at,
            frozen_by: f.frozen_by ?? null,
            reason: f.reason ?? null,
          };
        }
        return { ciclo, status: 'active' };
      });
    res.json({ cycles });
  } catch (err) {
    next(err);
  }
});

/**
 * POST /api/cycles/:ciclo/freeze
 * Body: { reason?: string, by?: string }
 */
router.post('/:ciclo/freeze', requireApiKey, async (req, res, next) => {
  try {
    if (!isDbConfigured()) {
      return res.status(503).json({ error: 'DATABASE_URL não configurada.' });
    }
    const ciclo = String(req.params.ciclo || '').trim();
    if (!ciclo) return res.status(400).json({ error: 'ciclo obrigatório' });
    const reason = req.body?.reason ? String(req.body.reason).slice(0, 500) : null;
    const by = req.body?.by ? String(req.body.by).slice(0, 200) : null;
    await frozenCyclesRepo.freezeCycle(ciclo, { reason, by });
    res.json({ ok: true, ciclo, frozen_at: new Date().toISOString() });
  } catch (err) {
    next(err);
  }
});

/**
 * DELETE /api/cycles/:ciclo/freeze
 */
router.delete('/:ciclo/freeze', requireApiKey, async (req, res, next) => {
  try {
    if (!isDbConfigured()) {
      return res.status(503).json({ error: 'DATABASE_URL não configurada.' });
    }
    const ciclo = String(req.params.ciclo || '').trim();
    if (!ciclo) return res.status(400).json({ error: 'ciclo obrigatório' });
    const deleted = await frozenCyclesRepo.unfreezeCycle(ciclo);
    res.json({ ok: true, ciclo, was_frozen: deleted });
  } catch (err) {
    next(err);
  }
});

export default router;
