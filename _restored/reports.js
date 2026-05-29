import { Router } from 'express';
import * as reportRepo from '../repositories/reportRepository.js';

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

router.get('/overview', async (req, res) => {
  try {
    const counts = await reportRepo.overview(parseFilters(req));
    res.json({ counts });
  } catch (err) {
    handleError(res, err);
  }
});

router.get('/:type', async (req, res) => {
  try {
    const type = req.params.type;
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
