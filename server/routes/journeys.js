import { Router } from 'express';
import {
  generateJourneyEventsForStudent,
  generateJourneyEventsBatch,
} from '../services/journeySchedulerService.js';

const router = Router();

function handleError(res, err) {
  console.error('[journeys]', err.message);
  res.status(err.status || 500).json({ error: err.message || 'Erro interno' });
}

router.post('/generate/:studentId', async (req, res) => {
  try {
    const result = await generateJourneyEventsForStudent(
      req.params.studentId,
      { recalculateFlow: req.body?.recalculateFlow !== false }
    );
    res.json(result);
  } catch (err) { handleError(res, err); }
});

router.post('/generate-batch', async (req, res) => {
  try {
    const ids = Array.isArray(req.body?.studentIds) ? req.body.studentIds : [];
    if (ids.length === 0) {
      return res.status(400).json({ error: 'Informe "studentIds" no body.' });
    }
    const r = await generateJourneyEventsBatch(ids);
    const fluxoCounts = { A: 0, B: 0, C: 0, INDEFINIDO: 0 };
    let totalEvents = 0;
    for (const item of r.results) {
      const key = item.fluxo || 'INDEFINIDO';
      fluxoCounts[key] = (fluxoCounts[key] || 0) + 1;
      totalEvents += (item.events || []).length;
    }
    res.json({
      processed: r.results.length,
      errors: r.errors,
      fluxoCounts,
      totalEvents,
    });
  } catch (err) { handleError(res, err); }
});

export default router;
