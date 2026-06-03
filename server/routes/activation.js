import { Router } from 'express';
import { isDbConfigured } from '../db/client.js';
import {
  ACTIVATION_CATEGORIES,
  activationListToCsv,
  assertActivationCategory,
  enrichActivationWithDatacrazy,
  enrichDocsPendentesWithDatacrazy,
  getDocsPendentesActivationList,
  getActivationRoster,
  getIntersectionActivationList,
  invalidateActivationRosterCache,
  markActivationDispatched,
  warmActivationRoster,
  notFoundItemsToCsv,
  runDatacrazyActivationBatch,
} from '../services/activationService.js';
import {
  getActivationTemplateConfig,
  setActivationTemplateConfig,
} from '../services/activationTemplateConfigService.js';
import * as activationResponseRepo from '../repositories/activationResponseRepository.js';
import { requireApiKey } from '../middleware/requireApiKey.js';

const router = Router();

function handleError(res, err) {
  console.error('[activation]', err.message);
  res.status(err.status || 500).json({
    error: err.message || 'Erro interno',
    code: err.code || undefined,
  });
}

function categorySlug(req) {
  return String(req.params.category || '').trim();
}

/**
 * Grava resposta de ativação (n8n / DataCrazy).
 * Body mínimo: { lead, evt, rgm?, cpf? } — se rgm vazio, busca RGM no último matriculados pelo CPF.
 */
router.post('/responses', requireApiKey, async (req, res) => {
  try {
    if (!isDbConfigured()) {
      return res.status(503).json({ error: 'DATABASE_URL não configurada.' });
    }
    const body = req.body ?? {};
    const datacrazyLeadId = body.lead ?? body.datacrazy_lead_id ?? body.datacrazyLeadId;
    const externalId = body.evt ?? body.external_id ?? body.externalId;
    if (!externalId) {
      return res.status(400).json({ error: 'evt (external_id) é obrigatório' });
    }
    const row = await activationResponseRepo.recordResponse({
      datacrazyLeadId: datacrazyLeadId ? String(datacrazyLeadId) : null,
      externalId: String(externalId),
      rgm: body.rgm ?? body.RGM ?? null,
      cpf: body.cpf ?? body.CPF ?? null,
      telefone: body.telefone ?? body.phone ?? null,
      category: body.category ?? null,
      responseKind: body.response_kind ?? body.responseKind ?? 'message',
      messageText: body.message_text ?? body.messageText ?? null,
      buttonPayload: body.button_payload ?? body.buttonPayload ?? null,
      rawPayload: body,
    });
    res.json({ ok: true, inserted: Boolean(row), row: row ?? null });
  } catch (err) {
    handleError(res, err);
  }
});

router.get('/template-config', async (_req, res) => {
  try {
    if (!isDbConfigured()) {
      return res.status(503).json({ error: 'DATABASE_URL não configurada.' });
    }
    const config = await getActivationTemplateConfig();
    res.json({ config });
  } catch (err) {
    handleError(res, err);
  }
});

router.put('/template-config/:category', requireApiKey, async (req, res) => {
  try {
    if (!isDbConfigured()) {
      return res.status(503).json({ error: 'DATABASE_URL não configurada.' });
    }
    const category = categorySlug(req);
    assertActivationCategory(category);
    const body = req.body || {};
    const config = await setActivationTemplateConfig(category, {
      first: body.first,
      repeat: body.repeat,
      fifth: body.fifth,
    });
    invalidateActivationRosterCache(category);
    res.json({ ok: true, config });
  } catch (err) {
    handleError(res, err);
  }
});

router.post('/:category/warm', async (req, res) => {
  try {
    if (!isDbConfigured()) {
      return res.status(503).json({ error: 'DATABASE_URL não configurada.' });
    }
    const category = categorySlug(req);
    assertActivationCategory(category);
    void warmActivationRoster(category).catch((err) => {
      console.error('[activation] warm falhou:', err.message);
    });
    res.json({ ok: true, warming: true, category });
  } catch (err) {
    handleError(res, err);
  }
});

router.get('/:category/list', async (req, res) => {
  try {
    if (!isDbConfigured()) {
      return res.status(503).json({ error: 'DATABASE_URL não configurada.' });
    }
    const category = categorySlug(req);
    assertActivationCategory(category);
    const includeSent = String(req.query.include_sent || '').toLowerCase() === 'true';
    const data = await getIntersectionActivationList(category, {
      excludeDispatched: !includeSent,
    });
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
    const includeSent = String(req.query.include_sent || '').toLowerCase() === 'true';
    const data = await getIntersectionActivationList(category, {
      excludeDispatched: !includeSent,
    });
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

router.get('/:category/roster', async (req, res) => {
  try {
    if (!isDbConfigured()) {
      return res.status(503).json({ error: 'DATABASE_URL não configurada.' });
    }
    const category = categorySlug(req);
    assertActivationCategory(category);
    const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 100, 1), 100);
    const offset = parseInt(req.query.offset, 10) || 0;
    const activationStage = req.query.activation_stage;
    const bbSubgrupo = req.query.bb_subgrupo || null;
    const ciclo = req.query.ciclo ? String(req.query.ciclo).trim() : undefined;
    const data = await getActivationRoster(category, { limit, offset, activationStage, bbSubgrupo, ciclo });
    res.json(data);
  } catch (err) {
    handleError(res, err);
  }
});

router.post('/:category/run-datacrazy-batch', requireApiKey, async (req, res) => {
  try {
    if (!isDbConfigured()) {
      return res.status(503).json({ error: 'DATABASE_URL não configurada.' });
    }
    const category = categorySlug(req);
    assertActivationCategory(category);
    const limit = req.body?.limit != null ? Number(req.body.limit) : 0;
    const masterKeys = Array.isArray(req.body?.master_keys)
      ? req.body.master_keys.map(String).filter((k) => k.length > 0)
      : undefined;
    const consultorId = req.headers['x-consultor-id'] ? Number(req.headers['x-consultor-id']) : null;
    const consultorNome = typeof req.headers['x-consultor-nome'] === 'string'
      ? req.headers['x-consultor-nome']
      : null;
    const data = await runDatacrazyActivationBatch(category, {
      limit,
      masterKeys,
      consultorId: Number.isFinite(consultorId) ? consultorId : null,
      consultorNome,
    });
    res.json(data);
  } catch (err) {
    handleError(res, err);
  }
});

router.post('/:category/not-found-export.csv', async (req, res) => {
  try {
    const category = categorySlug(req);
    assertActivationCategory(category);
    const items = Array.isArray(req.body?.items) ? req.body.items : [];
    const csv = notFoundItemsToCsv(items);
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="ativacao-${category}-nao-encontrados-datacrazy.csv"`
    );
    res.send(csv);
  } catch (err) {
    handleError(res, err);
  }
});

router.post('/:category/mark-dispatched', requireApiKey, async (req, res) => {
  try {
    if (!isDbConfigured()) {
      return res.status(503).json({ error: 'DATABASE_URL não configurada.' });
    }
    const category = categorySlug(req);
    assertActivationCategory(category);
    const masterKeys = Array.isArray(req.body?.master_keys)
      ? req.body.master_keys.map(String)
      : undefined;
    const markAllEligible = Boolean(req.body?.mark_all_eligible);
    const data = await markActivationDispatched(category, { masterKeys, markAllEligible });
    res.json(data);
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
