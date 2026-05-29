import { Router } from 'express';
import { isDbConfigured } from '../db/client.js';
import {
  ACTIVATION_CATEGORIES,
  activationListToCsv,
  assertActivationCategory,
  enrichActivationWithDatacrazy,
  enrichDocsPendentesWithDatacrazy,
  getDocsPendentesActivationList,
  getIntersectionActivationList,
} from '../services/activationService.js';

const router = Router();

function handleError(res, err) {
  console.error('[activation]', err.message);
  res.status(err.status || 500).json({ error: err.message || 'Erro interno' });
}

function categorySlug(req) {
  return String(req.params.category || '').trim();
}

router.get('/:category/list', async (req, res) => {
  try {
    if (!isDbConfigured()) {
      return res.status(503).json({ error: 'DATABASE_URL não configurada.' });
    }
    const category = categorySlug(req);
    assertActivationCategory(category);
    const data = await getIntersectionActivationList(category);
    res.json(data);
  } catch (err) {
    handleError(res, err);
  }
});

router.get('/:category/export.csv', async (req, res) => {
  try {
    if (!isDbConfigured()) {
      return res.status(503).json({ error: 'DATABASE_URL não configurada.' });
    }
    const category = categorySlug(req);
    assertActivationCategory(category);
    const data = await getIntersectionActivationList(category);
    const csv = activationListToCsv(data.items);
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="ativacao-${category}.csv"`
    );
    res.send(csv);
  } catch (err) {
    handleError(res, err);
  }
});

router.post('/:category/datacrazy', async (req, res) => {
  try {
    if (!isDbConfigured()) {
      return res.status(503).json({ error: 'DATABASE_URL não configurada.' });
    }
    const category = categorySlug(req);
    assertActivationCategory(category);
    const offset = req.body?.offset ?? req.query?.offset;
    const limit = req.body?.limit ?? req.query?.limit;
    const data = await enrichActivationWithDatacrazy(category, { offset, limit });
    res.json(data);
  } catch (err) {
    handleError(res, err);
  }
});

router.get('/docs-pendentes/list', async (_req, res) => {
  try {
    if (!isDbConfigured()) {
      return res.status(503).json({ error: 'DATABASE_URL não configurada.' });
    }
    const data = await getDocsPendentesActivationList();
    res.json(data);
  } catch (err) {
    handleError(res, err);
  }
});

router.post('/docs-pendentes/datacrazy', async (req, res) => {
  try {
    if (!isDbConfigured()) {
      return res.status(503).json({ error: 'DATABASE_URL não configurada.' });
    }
    const offset = req.body?.offset ?? req.query?.offset;
    const limit = req.body?.limit ?? req.query?.limit;
    const data = await enrichDocsPendentesWithDatacrazy({ offset, limit });
    res.json(data);
  } catch (err) {
    handleError(res, err);
  }
});

export { ACTIVATION_CATEGORIES };
export default router;
