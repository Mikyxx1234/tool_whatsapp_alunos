import { Router } from 'express';
import * as scheduledEventRepo from '../repositories/scheduledEventRepository.js';
import { runSingleCycle, getSchedulerStatus } from '../services/schedulerService.js';

const router = Router();

function handleError(res, err) {
  console.error('[scheduled-events]', err.message);
  res.status(err.status || 500).json({ error: err.message || 'Erro interno' });
}

router.get('/', async (req, res) => {
  try {
    const limit = Math.min(parseInt(req.query.limit, 10) || 100, 500);
    const offset = parseInt(req.query.offset, 10) || 0;
    const status = req.query.status || undefined;
    const studentId = req.query.studentId || undefined;
    const events = await scheduledEventRepo.list({
      status, studentId, limit, offset,
    });
    res.json({ events });
  } catch (err) { handleError(res, err); }
});

router.post('/:id/cancel', async (req, res) => {
  try {
    const reason = req.body?.reason || 'Cancelado manualmente';
    const event = await scheduledEventRepo.cancelById(req.params.id, reason);
    if (!event) {
      return res.status(404).json({ error: 'Evento não encontrado ou já finalizado.' });
    }
    res.json({ event });
  } catch (err) { handleError(res, err); }
});

/** Endpoint utilitário para forçar 1 ciclo do scheduler (útil em smoke). */
router.post('/run-now', async (_req, res) => {
  try {
    const r = await runSingleCycle();
    res.json(r);
  } catch (err) { handleError(res, err); }
});

router.get('/status', (_req, res) => {
  res.json(getSchedulerStatus());
});

export default router;
