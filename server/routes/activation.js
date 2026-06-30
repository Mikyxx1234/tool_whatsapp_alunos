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
  getActivationRosterKeys,
  getIntersectionActivationList,
  invalidateActivationRosterCache,
  markActivationDispatched,
  warmActivationRoster,
  notFoundItemsToCsv,
  runDatacrazyActivationBatch,
} from '../services/activationService.js';
import {
  createJob,
  updateProgress,
  completeJob,
  failJob,
  getJob,
  requestCancelJob,
  cancelJob,
} from '../services/activationJobsRegistry.js';
import {
  getActivationTemplateConfig,
  setActivationTemplateConfig,
} from '../services/activationTemplateConfigService.js';
import * as activationResponseRepo from '../repositories/activationResponseRepository.js';
import * as manualOutcomesRepo from '../repositories/manualOutcomesRepository.js';
import { requireApiKey } from '../middleware/requireApiKey.js';

const VALID_OUTCOMES = new Set(['revertido', 'confirmado', 'sem_contato', 'outro']);
const VALID_MEU_PAINEL_CATEGORIES = new Set([
  'docs-pendentes', 'financeiro', 'acessos-blackboard', 'processos-caa', 'provavel-evasao',
  'rematricula',
]);

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** Valida e normaliza um par de datas YYYY-MM-DD vindas de query string.
 *  Datas inválidas são silenciosamente descartadas (retornam null).
 *  Se from > to, os valores são trocados automaticamente.
 */
function parseDateRange(fromRaw, toRaw) {
  const from = fromRaw && DATE_RE.test(String(fromRaw)) ? String(fromRaw) : null;
  const to = toRaw && DATE_RE.test(String(toRaw)) ? String(toRaw) : null;
  if (from && to && from > to) return { from: to, to: from };
  return { from, to };
}

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
    // Consultor responsável vem do DataCrazy via webhook do n8n. Aceita várias
    // chaves possíveis pra robustez do contrato com o n8n.
    const consultorResponsavelNome =
      body.consultor_responsavel_nome ??
      body.consultorResponsavelNome ??
      body.consultor ??
      body.responsavel ??
      body.responsible_user_name ??
      null;
    const consultorNomeClean =
      typeof consultorResponsavelNome === 'string' && consultorResponsavelNome.trim()
        ? consultorResponsavelNome.trim().slice(0, 200)
        : null;

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
      consultorResponsavelNome: consultorNomeClean,
      rawPayload: body,
    });
    res.json({ ok: true, inserted: Boolean(row), row: row ?? null });
  } catch (err) {
    handleError(res, err);
  }
});

/* ============================================================================
   MEU PAINEL — endpoints da pagina de marcacao manual por consultor
   ----------------------------------------------------------------------------
   Identidade do consultor vem via query param (passado pelo dcz-crm-sync no
   src do iframe). Admin envia role=admin ou consultor=* para ver tudo.
   Supervisor Acadêmico (categoria do dcz) também tem poder pleno (decisão
   10/06/2026 — mesma capacidade de admin: ver tudo + reatribuir).
   ========================================================================== */

/** Normaliza string pra comparação case/accent-insensitive. */
function _normCat(s) {
  return String(s || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .trim()
    .toLowerCase();
}

/** True se a categoria do dcz é "Supervisor Acadêmico" (com ou sem acento). */
function _isSupervisorAcademicoCat(categoriaRaw) {
  return _normCat(categoriaRaw) === 'supervisor academico';
}

/** True se o requester tem poder pleno (role=admin OU categoria=Supervisor Acadêmico). */
function _hasFullAccess(req) {
  const role = String(req.query.role || '').trim().toLowerCase();
  if (role === 'admin') return true;
  const categoria = req.query.categoria || req.body?.categoria;
  return _isSupervisorAcademicoCat(categoria);
}

function resolveConsultor(req) {
  const consultorRaw = String(req.query.consultor || '').trim();
  if (_hasFullAccess(req) || consultorRaw === '*') {
    return { consultor: null, isAdmin: true };
  }
  if (!consultorRaw) {
    return { consultor: null, isAdmin: false, missing: true };
  }
  return { consultor: consultorRaw, isAdmin: false };
}

/** GET /api/activation/meu-painel/list */
router.get('/meu-painel/list', async (req, res) => {
  try {
    if (!isDbConfigured()) {
      return res.status(503).json({ error: 'DATABASE_URL não configurada.' });
    }
    const { consultor, isAdmin, missing } = resolveConsultor(req);
    if (missing) {
      return res.json({ consultor: null, is_admin: false, total: 0, items: [], missing_consultor: true });
    }
    const category = String(req.query.category || '').trim() || null;
    if (category && !VALID_MEU_PAINEL_CATEGORIES.has(category)) {
      return res.status(400).json({ error: `category invalida: ${category}` });
    }
    const { from, to } = parseDateRange(req.query.from, req.query.to);
    const rows = await manualOutcomesRepo.listMeuPainel({
      consultor,
      from,
      to,
      category,
      limit: req.query.limit,
      offset: req.query.offset,
    });
    res.json({
      consultor: consultor || null,
      is_admin: isAdmin,
      total: rows.length,
      items: rows,
    });
  } catch (err) {
    handleError(res, err);
  }
});

/** GET /api/activation/meu-painel/stats */
router.get('/meu-painel/stats', async (req, res) => {
  try {
    if (!isDbConfigured()) {
      return res.status(503).json({ error: 'DATABASE_URL não configurada.' });
    }
    const { consultor, isAdmin, missing } = resolveConsultor(req);
    if (missing) {
      return res.json({
        consultor: null,
        is_admin: false,
        missing_consultor: true,
        stats: {
          total_atribuido: 0, total_opt_out: 0, total_marcado: 0,
          total_revertido: 0, total_confirmado: 0, total_sem_contato: 0,
          total_outro: 0, taxa_reversao: 0,
        },
      });
    }
    const category = String(req.query.category || '').trim() || null;
    if (category && !VALID_MEU_PAINEL_CATEGORIES.has(category)) {
      return res.status(400).json({ error: `category invalida: ${category}` });
    }
    const { from: statsFrom, to: statsTo } = parseDateRange(req.query.from, req.query.to);
    const stats = await manualOutcomesRepo.meuPainelStats({
      consultor,
      from: statsFrom,
      to: statsTo,
      category,
    });
    res.json({ consultor: consultor || null, is_admin: isAdmin, stats });
  } catch (err) {
    handleError(res, err);
  }
});

/** GET /api/activation/meu-painel/origem-stats — contagem por origem_ativacao (coluna BASE) */
router.get('/meu-painel/origem-stats', async (req, res) => {
  try {
    if (!isDbConfigured()) {
      return res.status(503).json({ error: 'DATABASE_URL não configurada.' });
    }
    const { consultor, isAdmin, missing } = resolveConsultor(req);
    if (missing) {
      return res.json({
        consultor: null,
        is_admin: false,
        missing_consultor: true,
        items: [],
      });
    }
    const category = String(req.query.category || '').trim() || null;
    if (category && !VALID_MEU_PAINEL_CATEGORIES.has(category)) {
      return res.status(400).json({ error: `category invalida: ${category}` });
    }
    const { from: statsFrom, to: statsTo } = parseDateRange(req.query.from, req.query.to);
    const items = await manualOutcomesRepo.meuPainelOrigemCounts({
      consultor,
      from: statsFrom,
      to: statsTo,
      category,
    });
    res.json({ consultor: consultor || null, is_admin: isAdmin, items });
  } catch (err) {
    handleError(res, err);
  }
});

/** PATCH /api/activation/responses/:id/assign-consultor
 *  Admin (role=admin) ou Supervisor Acadêmico (categoria). Atualiza consultor_responsavel_nome.
 *  Body: { consultor_nome: string|null, role: string, categoria?: string }
 */
router.patch('/responses/:id/assign-consultor', async (req, res) => {
  try {
    if (!isDbConfigured()) {
      return res.status(503).json({ error: 'DATABASE_URL não configurada.' });
    }
    const body = req.body ?? {};
    const role = String(body.role || req.query.role || '').trim().toLowerCase();
    const categoria = body.categoria || req.query.categoria;
    const hasAccess = role === 'admin' || _isSupervisorAcademicoCat(categoria);
    if (!hasAccess) {
      return res.status(403).json({ error: 'Apenas admin ou Supervisor Acadêmico pode atribuir consultor manualmente.', code: 'forbidden' });
    }
    const id = String(req.params.id || '').trim();
    if (!id) {
      return res.status(400).json({ error: 'id da resposta e obrigatorio' });
    }
    const consultorNome = body.consultor_nome ?? body.consultorNome ?? null;
    const updated = await activationResponseRepo.updateConsultorResponsavel(id, consultorNome);
    if (!updated) {
      return res.status(404).json({ error: `resposta ${id} nao encontrada` });
    }
    res.json({ ok: true, row: updated });
  } catch (err) {
    handleError(res, err);
  }
});

/** GET /api/activation/consultores-distintos
 *  Lista nomes ja gravados em activation_responses para autocomplete.
 */
router.get('/consultores-distintos', async (_req, res) => {
  try {
    if (!isDbConfigured()) {
      return res.status(503).json({ error: 'DATABASE_URL não configurada.' });
    }
    const consultores = await activationResponseRepo.listDistinctConsultores();
    res.json({ consultores });
  } catch (err) {
    handleError(res, err);
  }
});

/** POST /api/activation/meu-painel/leads
 *  Cadastro manual de pessoa em Processos CAA (protocolo + RGM + consultor).
 */
router.post('/meu-painel/leads', async (req, res) => {
  try {
    if (!isDbConfigured()) {
      return res.status(503).json({ error: 'DATABASE_URL não configurada.' });
    }
    const body = req.body ?? {};
    const category = String(body.category || 'processos-caa').trim();
    if (!VALID_MEU_PAINEL_CATEGORIES.has(category)) {
      return res.status(400).json({ error: `category invalida: ${category}` });
    }
    const result = await manualOutcomesRepo.createManualMeuPainelLead({
      category,
      origem_ativacao: body.origem_ativacao ?? body.origemAtivacao ?? null,
      protocolo: body.protocolo ?? null,
      rgm: body.rgm,
      nome: body.nome ?? null,
      cpf: body.cpf ?? null,
      telefone: body.telefone ?? null,
      curso: body.curso ?? null,
      polo: body.polo ?? null,
      consultor_nome:
        String(body.consultor_nome || body.consultorNome || '').trim(),
    });
    res.status(201).json(result);
  } catch (err) {
    handleError(res, err);
  }
});

/** DELETE /api/activation/meu-painel/leads/:responseId
 *  Remove apenas leads criados manualmente (external_id manual:*).
 */
router.delete('/meu-painel/leads/:responseId', async (req, res) => {
  try {
    if (!isDbConfigured()) {
      return res.status(503).json({ error: 'DATABASE_URL não configurada.' });
    }
    const result = await manualOutcomesRepo.deleteManualMeuPainelLead(req.params.responseId);
    res.json(result);
  } catch (err) {
    handleError(res, err);
  }
});

/** POST /api/activation/meu-painel/outcomes
 *  Grava marcacao manual. Body:
 *    { category, rgm?, cpf?, nome?, protocolo?, master_key?,
 *      outcome, motivo?, notes?, consultor_nome, occurred_at? }
 *  consultor_nome aceita o nome vindo do dcz (session full_name derivado).
 */
router.post('/meu-painel/outcomes', async (req, res) => {
  try {
    if (!isDbConfigured()) {
      return res.status(503).json({ error: 'DATABASE_URL não configurada.' });
    }
    const body = req.body ?? {};
    const category = String(body.category || '').trim();
    const outcome = String(body.outcome || '').trim();
    const consultorNome =
      String(body.consultor_nome || body.consultorNome || '').trim().slice(0, 200);
    const rgm = body.rgm ? String(body.rgm).trim() : null;
    if (!VALID_MEU_PAINEL_CATEGORIES.has(category)) {
      return res.status(400).json({ error: `category invalida: ${category}` });
    }
    if (!VALID_OUTCOMES.has(outcome)) {
      return res.status(400).json({ error: `outcome invalido: ${outcome}. Use revertido | confirmado | sem_contato | outro` });
    }
    if (!consultorNome) {
      return res.status(400).json({ error: 'consultor_nome e obrigatorio' });
    }
    if (!rgm && !body.master_key) {
      return res.status(400).json({ error: 'rgm ou master_key e obrigatorio' });
    }
    const row = await manualOutcomesRepo.insertOutcome({
      category,
      master_key: body.master_key ?? (rgm ? `RGM:${rgm}` : null),
      rgm,
      cpf: body.cpf ? String(body.cpf).trim() : null,
      nome: body.nome ? String(body.nome).trim().slice(0, 200) : null,
      protocolo: body.protocolo ? String(body.protocolo).trim() : null,
      outcome,
      motivo: body.motivo ? String(body.motivo).trim().slice(0, 500) : null,
      notes: body.notes ? String(body.notes).trim().slice(0, 2000) : null,
      consultor_nome: consultorNome,
      occurred_at: body.occurred_at || null,
    });
    res.status(201).json({ ok: true, outcome: row });
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

router.get('/:category/roster/keys', async (req, res) => {
  try {
    if (!isDbConfigured()) {
      return res.status(503).json({ error: 'DATABASE_URL não configurada.' });
    }
    const category = categorySlug(req);
    assertActivationCategory(category);
    const activationStage = req.query.activation_stage;
    const bbSubgrupo = req.query.bb_subgrupo || null;
    const rematSubgrupo = req.query.remat_subgrupo || null;
    const ciclo = req.query.ciclo ? String(req.query.ciclo).trim() : undefined;
    const VALID_RESPONSE_FILTERS = new Set(['all', 'responded', 'not_responded']);
    const responseFilterRaw = String(req.query.responseFilter || req.query.response_filter || '');
    const responseFilter = VALID_RESPONSE_FILTERS.has(responseFilterRaw) ? responseFilterRaw : 'all';
    const sort = req.query.sort ? String(req.query.sort).trim() : undefined;
    const search = req.query.search ? String(req.query.search).trim() : undefined;
    const data = await getActivationRosterKeys(category, {
      activationStage,
      bbSubgrupo,
      rematSubgrupo,
      ciclo,
      responseFilter,
      sort,
      search,
    });
    res.json(data);
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
    const rematSubgrupo = req.query.remat_subgrupo || null;
    const ciclo = req.query.ciclo ? String(req.query.ciclo).trim() : undefined;
    const VALID_RESPONSE_FILTERS = new Set(['all', 'responded', 'not_responded']);
    const responseFilterRaw = String(req.query.responseFilter || req.query.response_filter || '');
    const responseFilter = VALID_RESPONSE_FILTERS.has(responseFilterRaw) ? responseFilterRaw : 'all';
    const sort = req.query.sort ? String(req.query.sort).trim() : undefined;
    const search = req.query.search ? String(req.query.search).trim() : undefined;
    const data = await getActivationRoster(category, {
      limit,
      offset,
      activationStage,
      bbSubgrupo,
      rematSubgrupo,
      ciclo,
      responseFilter,
      sort,
      search,
    });
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
    const operatorNome = (req.body?.operator_nome ?? '').toString().trim() || null;

    if (req.query.async === '1') {
      const { jobId } = createJob({ category, total: 0 });
      res.status(202).json({ jobId, status: 'running' });
      (async () => {
        try {
          const data = await runDatacrazyActivationBatch(
            category,
            { limit, masterKeys, operatorNome, jobId },
            {
              onTotal: ({ total }) => updateProgress(jobId, { total: total ?? 0 }),
              onProgress: (patch) => updateProgress(jobId, patch),
            }
          );
          const job = getJob(jobId);
          if (job?.cancel_requested) {
            cancelJob(jobId, { result: data });
          } else {
            completeJob(jobId, { result: data });
          }
        } catch (err) {
          if (err?.code === 'cancelled') {
            cancelJob(jobId, { error: err.message });
          } else {
            failJob(jobId, { error: err?.message || String(err) });
          }
        }
      })();
      return;
    }

    const data = await runDatacrazyActivationBatch(category, { limit, masterKeys, operatorNome });
    res.json(data);
  } catch (err) {
    handleError(res, err);
  }
});

router.get('/jobs/:jobId/progress', requireApiKey, (req, res) => {
  const job = getJob(req.params.jobId);
  if (!job) return res.status(404).json({ error: 'job não encontrado' });
  res.json(job);
});

router.post('/jobs/:jobId/cancel', requireApiKey, (req, res) => {
  const ok = requestCancelJob(req.params.jobId);
  if (!ok) return res.status(404).json({ error: 'job não encontrado ou já finalizado' });
  res.json({ ok: true, jobId: req.params.jobId });
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
