import { Router } from 'express';
import express from 'express';
import fs from 'node:fs';
import { isDbConfigured } from '../db/client.js';
import { requireApiKey } from '../middleware/requireApiKey.js';
import * as service from '../services/manualOutcomesService.js';
import { findOpenProtocolsByRgm } from '../repositories/caaProtocolsRepository.js';

const router = Router();

const rawProofUpload = express.raw({ type: () => true, limit: '10mb' });

function handleError(res, err) {
  console.error('[manual-outcomes]', err.message);
  res.status(err.status || 500).json({ error: err.message || 'Erro interno' });
}

router.post('/', requireApiKey, async (req, res) => {
  try {
    if (!isDbConfigured()) {
      return res.status(503).json({ error: 'DATABASE_URL não configurada.' });
    }
    const outcome = await service.createOutcome(req.body ?? {});
    res.status(201).json({ ok: true, outcome });
  } catch (err) {
    handleError(res, err);
  }
});

router.get('/', requireApiKey, async (req, res) => {
  try {
    if (!isDbConfigured()) {
      return res.status(503).json({ error: 'DATABASE_URL não configurada.' });
    }
    const items = await service.listOutcomes(req.query);
    res.json({ items });
  } catch (err) {
    handleError(res, err);
  }
});

router.get('/protocols-by-rgm/:rgm', requireApiKey, async (req, res) => {
  try {
    if (!isDbConfigured()) {
      return res.status(503).json({ error: 'DATABASE_URL não configurada.' });
    }
    const protocols = await findOpenProtocolsByRgm(req.params.rgm);
    res.json({ protocols });
  } catch (err) {
    handleError(res, err);
  }
});

router.get('/:id', requireApiKey, async (req, res) => {
  try {
    if (!isDbConfigured()) {
      return res.status(503).json({ error: 'DATABASE_URL não configurada.' });
    }
    const outcome = await service.getOutcome(req.params.id);
    if (!outcome) {
      return res.status(404).json({ error: 'Desfecho não encontrado' });
    }
    res.json({ outcome });
  } catch (err) {
    handleError(res, err);
  }
});

router.post('/:id/proof', requireApiKey, rawProofUpload, async (req, res) => {
  try {
    if (!isDbConfigured()) {
      return res.status(503).json({ error: 'DATABASE_URL não configurada.' });
    }
    const buffer = Buffer.isBuffer(req.body) ? req.body : Buffer.from(req.body || []);
    if (!buffer.length) {
      return res.status(400).json({ error: 'Arquivo vazio.' });
    }
    const fileName = decodeURIComponent(String(req.headers['x-file-name'] || 'proof.bin'));
    const mime = String(req.headers['content-type'] || 'application/octet-stream').split(';')[0].trim();
    const updated = await service.saveProof(req.params.id, buffer, fileName, mime);
    res.json({ ok: true, outcome: updated });
  } catch (err) {
    handleError(res, err);
  }
});

router.get('/:id/proof', requireApiKey, async (req, res) => {
  try {
    if (!isDbConfigured()) {
      return res.status(503).json({ error: 'DATABASE_URL não configurada.' });
    }
    const outcome = await service.getOutcome(req.params.id);
    if (!outcome) {
      return res.status(404).json({ error: 'Desfecho não encontrado' });
    }
    if (!outcome.proof_path) {
      return res.status(404).json({ error: 'Este desfecho não tem anexo.' });
    }
    if (!fs.existsSync(outcome.proof_path)) {
      return res.status(404).json({ error: 'Arquivo de prova não encontrado no disco.' });
    }
    res.setHeader('Content-Type', outcome.proof_mime || 'application/octet-stream');
    res.setHeader('Content-Disposition', 'inline');
    res.sendFile(outcome.proof_path);
  } catch (err) {
    handleError(res, err);
  }
});

router.delete('/:id/proof', requireApiKey, async (req, res) => {
  try {
    if (!isDbConfigured()) {
      return res.status(503).json({ error: 'DATABASE_URL não configurada.' });
    }
    await service.removeProof(req.params.id);
    res.json({ ok: true });
  } catch (err) {
    handleError(res, err);
  }
});

router.delete('/:id', requireApiKey, async (req, res) => {
  try {
    if (!isDbConfigured()) {
      return res.status(503).json({ error: 'DATABASE_URL não configurada.' });
    }
    await service.deleteOutcome(req.params.id);
    res.json({ ok: true });
  } catch (err) {
    handleError(res, err);
  }
});

export default router;
