import { Router } from 'express';
import { isDbConfigured } from '../db/client.js';
import { requireFullAccess } from '../middleware/requireFullAccess.js';
import * as metasRepo from '../repositories/consultorMetasRepository.js';

const router = Router();

function handleError(res, err) {
  console.error('[consultor-metas]', err.message);
  res.status(err.status || 500).json({ error: err.message || 'Erro interno' });
}

router.post('/consultores', async (req, res) => {
  try {
    if (!requireFullAccess(req, res)) return;
    if (!isDbConfigured()) {
      return res.status(503).json({ error: 'DATABASE_URL não configurada.' });
    }
    const ano_mes = String(req.body?.ano_mes || '').trim();
    const catalogo = Array.isArray(req.body?.catalogo) ? req.body.catalogo : [];
    const consultores = await metasRepo.listConsultoresCatalogo({ ano_mes, catalogo });
    res.json({ ok: true, consultores });
  } catch (err) {
    handleError(res, err);
  }
});

router.get('/', async (req, res) => {
  try {
    if (!requireFullAccess(req, res)) return;
    if (!isDbConfigured()) {
      return res.status(503).json({ error: 'DATABASE_URL não configurada.' });
    }
    const ano_mes = req.query.ano_mes ? String(req.query.ano_mes) : null;
    const items = await metasRepo.listMetas({ ano_mes });
    res.json({ ok: true, items });
  } catch (err) {
    handleError(res, err);
  }
});

router.post('/', async (req, res) => {
  try {
    if (!requireFullAccess(req, res)) return;
    if (!isDbConfigured()) {
      return res.status(503).json({ error: 'DATABASE_URL não configurada.' });
    }
    const row = await metasRepo.upsertMeta({ ...(req.body || {}), catalogo: req.body?.catalogo });
    res.status(201).json({ ok: true, row });
  } catch (err) {
    handleError(res, err);
  }
});

router.delete('/:id', async (req, res) => {
  try {
    if (!requireFullAccess(req, res)) return;
    if (!isDbConfigured()) {
      return res.status(503).json({ error: 'DATABASE_URL não configurada.' });
    }
    const ok = await metasRepo.deleteMeta(req.params.id);
    if (!ok) return res.status(404).json({ error: 'Meta não encontrada.' });
    res.json({ ok: true });
  } catch (err) {
    handleError(res, err);
  }
});

export default router;
