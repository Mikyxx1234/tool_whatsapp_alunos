import { Router } from 'express';
import express from 'express';
import { isDbConfigured } from '../db/client.js';
import * as baseUploadRepo from '../repositories/baseUploadRepository.js';
import { invalidateComparisonCache } from '../services/baseComparisonService.js';
import { invalidateOverviewCache } from '../services/reportOverviewCache.js';
import { invalidateActivationListCache } from '../services/activationService.js';
import { bustCicloCache } from '../services/cicloResolverService.js';
import {
  csvTextToRowObjectsFast,
  xlsxBufferToRowObjects,
} from '../utils/spreadsheetToObjects.js';
import { requireApiKey } from '../middleware/requireApiKey.js';

const router = Router();

const rawFileUpload = express.raw({
  type: () => true,
  limit: process.env.BASE_UPLOAD_MAX_BYTES || '160mb',
});

function afterBaseUpload(category) {
  invalidateComparisonCache();
  invalidateOverviewCache();
  if (category === 'matriculados') {
    bustCicloCache();
    invalidateActivationListCache();
  } else {
    invalidateActivationListCache(category);
  }
}

function handleError(res, err) {
  console.error('[base-uploads]', err.message);
  if (err.stack) console.error(err.stack);
  res.status(err.status || 500).json({ error: err.message || 'Erro interno' });
}

function assertCategory(category) {
  if (!baseUploadRepo.BASE_CATEGORIES.includes(category)) {
    const err = new Error(`Categoria inválida: ${category}`);
    err.status = 400;
    throw err;
  }
}

router.get('/:category/snapshots', async (req, res) => {
  try {
    if (!isDbConfigured()) {
      return res.status(503).json({ error: 'DATABASE_URL não configurada.' });
    }
    const snapshots = await baseUploadRepo.listSnapshots(req.params.category);
    res.json({ snapshots });
  } catch (err) {
    handleError(res, err);
  }
});

/** XLSX/CSV binário — evita converter 100k+ linhas no navegador. */
router.post('/:category/upload-file', requireApiKey, rawFileUpload, async (req, res) => {
  const category = req.params.category;
  try {
    if (!isDbConfigured()) {
      return res.status(503).json({ error: 'DATABASE_URL não configurada.' });
    }
    assertCategory(category);
    const fileName = decodeURIComponent(String(req.headers['x-file-name'] || 'upload.bin'));
    const buffer = Buffer.isBuffer(req.body) ? req.body : Buffer.from(req.body || []);
    if (!buffer.length) {
      return res.status(400).json({ error: 'Arquivo vazio.' });
    }
    console.log(
      `[base-uploads] upload-file ${category}: "${fileName}" (${(buffer.length / 1024 / 1024).toFixed(1)} MB)…`
    );
    const t0 = Date.now();
    const isXlsx = /\.(xlsx|xls|xlsm|xlsb|ods)$/i.test(fileName);
    const objects = isXlsx
      ? xlsxBufferToRowObjects(buffer, fileName)
      : csvTextToRowObjectsFast(buffer.toString('utf8'));
    const result = await baseUploadRepo.createSnapshotFromRowObjects(category, {
      fileName,
      fileSizeBytes: buffer.length,
      objects,
    });
    console.log(
      `[base-uploads] ok ${category} (arquivo) em ${((Date.now() - t0) / 1000).toFixed(1)}s (${result.rowCount} linhas)`
    );
    afterBaseUpload(category);
    res.status(201).json(result);
  } catch (err) {
    handleError(res, err);
  }
});

router.post('/:category/upload', async (req, res) => {
  const category = req.params.category;
  try {
    if (!isDbConfigured()) {
      return res.status(503).json({ error: 'DATABASE_URL não configurada.' });
    }
    assertCategory(category);
    const { fileName, csvText, fileSizeBytes, metadata } = req.body || {};
    if (!csvText || !fileName) {
      return res.status(400).json({ error: 'fileName e csvText são obrigatórios.' });
    }
    const lineEstimate = String(csvText).split(/\r?\n/).length;
    console.log(
      `[base-uploads] importando ${category}: "${fileName}" (~${lineEstimate.toLocaleString('pt-BR')} linhas CSV)…`
    );
    const t0 = Date.now();
    const result = await baseUploadRepo.createSnapshotFromCsv(category, {
      fileName,
      csvText,
      fileSizeBytes,
      metadata,
    });
    console.log(
      `[base-uploads] ok ${category} em ${((Date.now() - t0) / 1000).toFixed(1)}s (${result.rowCount} linhas)`
    );
    afterBaseUpload(category);
    res.status(201).json(result);
  } catch (err) {
    handleError(res, err);
  }
});

router.delete('/:category/snapshots/:snapshotId', requireApiKey, async (req, res) => {
  try {
    if (!isDbConfigured()) {
      return res.status(503).json({ error: 'DATABASE_URL não configurada.' });
    }
    const deleted = await baseUploadRepo.deleteSnapshot(
      req.params.category,
      req.params.snapshotId
    );
    if (!deleted) {
      return res.status(404).json({ error: 'Snapshot não encontrado.' });
    }
    afterBaseUpload(req.params.category);
    res.json({ ok: true });
  } catch (err) {
    handleError(res, err);
  }
});

export default router;
