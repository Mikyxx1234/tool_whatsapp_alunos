import { Router } from 'express';
import { isDbConfigured } from '../db/client.js';
import { requireFullAccess } from '../middleware/requireFullAccess.js';
import { getPainelOverview } from '../services/painelOverviewService.js';
import { normalizeCrmFonte } from '../utils/crmFonte.js';

const router = Router();

async function handleOverview(req, res) {
  try {
    if (!requireFullAccess(req, res)) return;
    if (!isDbConfigured()) {
      return res.status(503).json({ error: 'DATABASE_URL não configurada.' });
    }
    const q = req.method === 'POST' ? { ...req.query, ...req.body } : req.query;
    const catalogo = Array.isArray(q.catalogo) ? q.catalogo : [];
    const data = await getPainelOverview({
      from: q.from || null,
      to: q.to || null,
      period_days: q.period_days || 30,
      perfil: q.perfil || 'caa',
      ref_dia: q.ref_dia || null,
      origem_ativacao: q.origem_ativacao || null,
      crm_fonte: normalizeCrmFonte(q.crm_fonte),
      catalogo,
    });
    res.json({ ok: true, data });
  } catch (err) {
    console.error('[painel]', err.message);
    res.status(err.status || 500).json({ error: err.message || 'Erro interno' });
  }
}

router.get('/overview', handleOverview);
router.post('/overview', handleOverview);

export default router;
