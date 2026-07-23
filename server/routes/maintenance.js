/**
 * Rotas de manutenção operacional. Protegidas por requireApiKey (decisão de
 * 26/05/2026 — hardening).
 */
import { Router } from 'express';
import { requireApiKey } from '../middleware/requireApiKey.js';
import { cleanStaleOrigemAtivacao } from '../services/activationOrigemCleanupService.js';
import { cleanStaleActivationTags } from '../services/activationNovoCrmTagCleanupService.js';
import { syncCaaDesfechos } from '../services/crmDesfechoSyncService.js';
import { syncResponseConsultores } from '../services/crmConsultorSyncService.js';
import { runFullSync, startFullSyncBackground } from '../services/datacrazyLeadCacheSyncService.js';
import * as datacrazyLeadCacheRepo from '../repositories/datacrazyLeadCacheRepository.js';
import {
  runNovoCrmCacheSync,
  startNovoCrmCacheSyncBackground,
} from '../services/novoCrmPersonCacheSyncService.js';
import * as novoCrmPersonCacheRepo from '../repositories/novoCrmPersonCacheRepository.js';
import {
  previewEnrichment,
  startEnrichmentApplyBackground,
  getEnrichmentJob,
  getRunningEnrichmentJob,
} from '../services/novoCrmEnrichmentService.js';
import {
  runMatriculadosProvision,
  runMatriculadosProvisionLocked,
  startMatriculadosProvisionBackground,
  isMatriculadosProvisionRunning,
  isProvisionAllowedOnThisHost,
} from '../services/novoCrmMatriculadosProvisionService.js';
import {
  runFlagsStageSync,
  runFlagsStageSyncLocked,
  startFlagsStageSyncBackground,
  isFlagsStageSyncRunning,
  getFlagsStageSyncJob,
  getRunningFlagsStageSyncJob,
} from '../services/novoCrmFlagsStageSyncService.js';
import * as activationResponseRepo from '../repositories/activationResponseRepository.js';
import { query } from '../db/client.js';
import { migrateMeuPainelLegacyFromLive } from '../repositories/meuPainelLegacyRepository.js';

const router = Router();

/**
 * POST /api/maintenance/clean-stale-origem-ativacao
 *
 * Limpa `origem_ativacao` no CRM para leads que tiveram um SET há mais de
 * `journey_settings.origem_ativacao_stale_hours` (default 72h) sem CLEAR
 * posterior. Idempotente.
 *
 * Query: ?dry_run=true  -> só conta, não chama CRM.
 * Body : { "dry_run": true } -> idem.
 *
 * Response:
 *   { scanned, cleaned, failed, errors[], stale_window_hours, dry_run, ran_at }
 */
router.post('/clean-stale-origem-ativacao', requireApiKey, async (req, res, next) => {
  try {
    const dryRun =
      req.query?.dry_run === 'true' ||
      req.query?.dry_run === '1' ||
      req.body?.dry_run === true;
    const result = await cleanStaleOrigemAtivacao({ dryRun });
    res.json(result);
  } catch (err) {
    next(err);
  }
});

/**
 * POST /api/maintenance/clean-stale-activation-tags
 *
 * Remove tags ativacao-* no CRM EduIT para SETs no log local há mais de
 * `journey_settings.origem_ativacao_stale_hours` (mesma janela da origem)
 * sem CLEAR posterior. Idempotente.
 *
 * Query/body: dry_run=true → só conta.
 */
router.post('/clean-stale-activation-tags', requireApiKey, async (req, res, next) => {
  try {
    const dryRun =
      req.query?.dry_run === 'true' ||
      req.query?.dry_run === '1' ||
      req.body?.dry_run === true;
    const result = await cleanStaleActivationTags({ dryRun });
    res.json(result);
  } catch (err) {
    next(err);
  }
});

/**
 * POST /api/maintenance/sync-crm-desfechos
 *
 * Lê o campo de desfecho CAA (DATACRAZY_DESFECHO_CAA_FIELD_ID) no CRM
 * para cada lead CAA disparado recentemente. Valores "Sim"/"Não" viram
 * entradas em `activation_manual_outcomes` e o campo é limpo no CRM.
 *
 * Query: ?dry_run=true  -> conta sem gravar.
 *        ?days=N        -> janela de lookback em dias (default: env ou 14).
 *
 * Response:
 *   { scanned, synced_revertido, synced_confirmado, ignored, failed,
 *     errors[], lookback_days, dry_run, ran_at, crm_rate_per_second }
 */
router.post('/sync-crm-desfechos', requireApiKey, async (req, res, next) => {
  try {
    const dryRun =
      req.query?.dry_run === 'true' ||
      req.query?.dry_run === '1' ||
      req.body?.dry_run === true;
    const days = req.query?.days ? Number(req.query.days) : null;
    const result = await syncCaaDesfechos({ dryRun, days });
    res.json(result);
  } catch (err) {
    next(err);
  }
});

/**
 * GET /api/maintenance/datacrazy-cache-status
 *
 * Contagem do cache + último sync + se há sync em andamento.
 */
router.get('/datacrazy-cache-status', requireApiKey, async (req, res) => {
  try {
    await datacrazyLeadCacheRepo.closeStaleRunningSyncs();
    const stats = await datacrazyLeadCacheRepo.getCacheStats();
    res.json({
      ok: true,
      cache_count: stats.cache_count,
      running: Boolean(stats.running),
      running_since: stats.running?.started_at ?? null,
      last_sync: stats.last_sync
        ? {
            id: String(stats.last_sync.id),
            started_at: stats.last_sync.started_at,
            finished_at: stats.last_sync.finished_at,
            pages: stats.last_sync.pages_scanned,
            leads_seen: stats.last_sync.leads_seen,
            leads_upserted: stats.last_sync.leads_upserted,
            leads_skipped: stats.last_sync.leads_skipped,
            status: stats.last_sync.status,
            error_message: stats.last_sync.error_message,
          }
        : null,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * POST /api/maintenance/sync-datacrazy-cache
 *
 * Dispara o sync completo do cache cpf → datacrazy_lead_id varrendo todas as
 * páginas da API DataCrazy. Idempotente — pode ser chamado a qualquer hora.
 *
 * Query: ?dryRun=1  → conta sem persistir.
 *        ?async=1   → 202 imediato, sync em background (recomendado na UI).
 *
 * Response:
 *   { logId, pages, leadsSeen, upserted, skipped, durationMs, dry_run }
 */
router.post('/sync-datacrazy-cache', requireApiKey, async (req, res) => {
  try {
    const dryRun = req.query.dryRun === '1';
    const asyncMode = req.query.async === '1' || req.query.async === 'true';

    if (asyncMode) {
      await datacrazyLeadCacheRepo.closeStaleRunningSyncs();
      const stats = await datacrazyLeadCacheRepo.getCacheStats();
      if (stats.running) {
        return res.status(409).json({ error: 'Sync já em andamento', running_since: stats.running.started_at });
      }
      const started = startFullSyncBackground({ dryRun });
      if (!started) {
        return res.status(409).json({ error: 'Sync já em andamento' });
      }
      return res.status(202).json({ ok: true, status: 'running', dry_run: dryRun });
    }

    const result = await runFullSync({ dryRun });
    res.json(result);
  } catch (err) {
    console.error('[sync-datacrazy-cache]', err);
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /api/maintenance/novo-crm-cache-status
 *
 * Status do espelho local do CRM EduIT: contagem, último sync, cursor e
 * regressões abertas.
 */
router.get('/novo-crm-cache-status', requireApiKey, async (_req, res) => {
  try {
    await novoCrmPersonCacheRepo.closeStaleRunningSyncs();
    const stats = await novoCrmPersonCacheRepo.getCacheStats();
    res.json({
      ok: true,
      cache_total: stats.total,
      cache_active: stats.active,
      missing_cpf: stats.missing_cpf ?? 0,
      missing_rgm: stats.missing_rgm ?? 0,
      incomplete_fields: stats.incomplete_fields ?? 0,
      running: Boolean(stats.running),
      running_sync: stats.running,
      last_sync: stats.last_sync,
      state: stats.state,
      open_data_loss_events: stats.open_data_loss_events,
    });
  } catch (err) {
    res.status(500).json({ error: err?.message || String(err) });
  }
});

/**
 * POST /api/maintenance/sync-novo-crm-cache?mode=full|incremental&async=1
 *
 * Full é intencionalmente "sem pressa" para rodar de madrugada. Use async=1
 * na operação normal.
 */
router.post('/sync-novo-crm-cache', requireApiKey, async (req, res) => {
  try {
    const mode = req.query.mode === 'full' || req.body?.mode === 'full' ? 'full' : 'incremental';
    const dryRun =
      req.query.dryRun === '1' ||
      req.query.dry_run === 'true' ||
      req.body?.dryRun === true ||
      req.body?.dry_run === true;
    const asyncMode = req.query.async === '1' || req.query.async === 'true' || req.body?.async === true;
    const samplePctRaw = req.query.sample_pct ?? req.query.samplePct ?? req.body?.sample_pct ?? req.body?.samplePct;
    const maxContactsRaw = req.query.max_contacts ?? req.query.maxContacts ?? req.body?.max_contacts ?? req.body?.maxContacts;
    const samplePct = samplePctRaw != null && String(samplePctRaw).trim() !== '' ? Number(samplePctRaw) : null;
    const maxContacts =
      maxContactsRaw != null && String(maxContactsRaw).trim() !== '' ? Number(maxContactsRaw) : null;
    const syncOpts = { mode, dryRun, samplePct, maxContacts };

    if (asyncMode) {
      await novoCrmPersonCacheRepo.closeStaleRunningSyncs();
      const stats = await novoCrmPersonCacheRepo.getCacheStats();
      if (stats.running) {
        return res.status(409).json({
          error: 'Sync Novo CRM já em andamento',
          running_since: stats.running.started_at,
        });
      }
      const started = startNovoCrmCacheSyncBackground(syncOpts);
      if (!started) return res.status(409).json({ error: 'Sync Novo CRM já em andamento' });
      return res.status(202).json({
        ok: true,
        status: 'running',
        mode,
        dry_run: dryRun,
        sample_pct: samplePct,
        max_contacts: maxContacts,
      });
    }

    const result = await runNovoCrmCacheSync(syncOpts);
    res.json(result);
  } catch (err) {
    console.error('[sync-novo-crm-cache]', err);
    const status = err?.status && Number(err.status) >= 400 ? Number(err.status) : 500;
    res.status(status).json({ error: err?.message || String(err) });
  }
});

/**
 * GET /api/maintenance/novo-crm-cache-regressions
 */
router.get('/novo-crm-cache-regressions', requireApiKey, async (req, res) => {
  try {
    const limit = req.query.limit ? Number(req.query.limit) : 100;
    const acknowledged = req.query.acknowledged === '1' || req.query.acknowledged === 'true';
    const events = await novoCrmPersonCacheRepo.listDataLossEvents({ limit, acknowledged });
    res.json({ ok: true, events });
  } catch (err) {
    res.status(500).json({ error: err?.message || String(err) });
  }
});

/**
 * POST /api/maintenance/novo-crm-cache-regressions/:id/ack
 */
router.post('/novo-crm-cache-regressions/:id/ack', requireApiKey, async (req, res) => {
  try {
    const event = await novoCrmPersonCacheRepo.acknowledgeDataLossEvent(
      req.params.id,
      req.body?.acknowledged_by || req.body?.user || null
    );
    if (!event) return res.status(404).json({ error: 'Evento não encontrado' });
    res.json({ ok: true, event });
  } catch (err) {
    res.status(500).json({ error: err?.message || String(err) });
  }
});

/**
 * POST /api/maintenance/enrich-novo-crm?scope=cpf|rgm|incomplete|all_mapped&dry_run=1|0&async=1
 *
 * dry_run=1 (default): prévia síncrona.
 * dry_run=0&async=1: grava em background.
 */
router.post('/enrich-novo-crm', requireApiKey, async (req, res) => {
  try {
    const scope = String(req.query.scope || req.body?.scope || 'incomplete').trim();
    const forceWrite =
      req.query.dry_run === '0' ||
      req.query.dry_run === 'false' ||
      req.body?.dry_run === false ||
      req.body?.dryRun === false;
    const isDry = !forceWrite;
    const asyncMode =
      req.query.async === '1' || req.query.async === 'true' || req.body?.async === true;

    if (isDry) {
      const preview = await previewEnrichment({ scope });
      return res.json(preview);
    }

    const running = getRunningEnrichmentJob();
    if (running) {
      return res.status(409).json({
        error: 'Enriquecimento já em andamento',
        jobId: running.jobId,
      });
    }
    const started = startEnrichmentApplyBackground({ scope });
    if (!started.started) {
      return res.status(409).json({
        error: started.error || 'Enriquecimento já em andamento',
        jobId: started.jobId,
      });
    }
    return res.status(202).json({
      ok: true,
      status: 'running',
      jobId: started.jobId,
      scope,
      dry_run: false,
      async: Boolean(asyncMode),
    });
  } catch (err) {
    console.error('[enrich-novo-crm]', err);
    const status = err?.status && Number(err.status) >= 400 ? Number(err.status) : 500;
    res.status(status).json({ error: err?.message || String(err) });
  }
});

/**
 * POST /api/maintenance/provision-matriculados-novo-crm
 * ?dry_run=1&max=1000&async=1
 *
 * Cria no CRM (DEV) alunos do snapshot matriculados que ainda não existem.
 * Aplica etapa + flags pelas regras. Conservador: delay alto, max por run.
 */
router.post('/provision-matriculados-novo-crm', requireApiKey, async (req, res) => {
  try {
    if (!isProvisionAllowedOnThisHost()) {
      return res.status(403).json({
        error:
          'Provision só no CRM DEV (crm-dev…). Ou NOVO_CRM_PROVISION_ALLOW_PROD=1.',
      });
    }
    const forceWrite =
      req.query.dry_run === '0' ||
      req.query.dry_run === 'false' ||
      req.body?.dry_run === false ||
      req.body?.dryRun === false;
    const reallyDry = !forceWrite;
    const maxCreates = Number(req.query.max || req.body?.max || req.body?.maxCreates) || undefined;
    const asyncMode =
      req.query.async === '1' || req.query.async === 'true' || req.body?.async === true;

    if (reallyDry) {
      const preview = await runMatriculadosProvision({
        dryRun: true,
        maxCreates: maxCreates || 50,
      });
      return res.json(preview);
    }

    if (String(process.env.NOVO_CRM_PROVISION_ENABLED || '').trim() !== '1') {
      return res.status(403).json({
        error: 'NOVO_CRM_PROVISION_ENABLED≠1 — escrita bloqueada (dry_run ainda permitido).',
      });
    }

    if (isMatriculadosProvisionRunning()) {
      return res.status(409).json({ error: 'Provision já em andamento' });
    }

    if (asyncMode) {
      const started = startMatriculadosProvisionBackground({
        dryRun: false,
        maxCreates,
      });
      if (!started) return res.status(409).json({ error: 'Provision já em andamento' });
      return res.status(202).json({
        ok: true,
        status: 'running',
        dry_run: false,
        max_creates: maxCreates || null,
      });
    }

    const result = await runMatriculadosProvisionLocked({ dryRun: false, maxCreates });
    res.json(result);
  } catch (err) {
    console.error('[provision-matriculados-novo-crm]', err);
    const status = err?.status && Number(err.status) >= 400 ? Number(err.status) : 500;
    res.status(status).json({ error: err?.message || String(err) });
  }
});

/**
 * POST /api/maintenance/sync-flags-stage-novo-crm
 * ?dry_run=1|0&mode=flags_stage|fields|both&async=1&max=
 *
 * Atualiza flags (Sim/Não) e/ou move etapa dos deals existentes.
 * Intocáveis: Ganho, Retenção, Cancelado (não move etapa).
 * Preferir dry_run=1 primeiro. Botão manual na UI Sync Novo CRM.
 */
router.post('/sync-flags-stage-novo-crm', requireApiKey, async (req, res) => {
  try {
    if (!isProvisionAllowedOnThisHost()) {
      return res.status(403).json({
        error:
          'Sync fields/flags bloqueado neste host. Use CRM DEV ou NOVO_CRM_PROVISION_ALLOW_PROD=1 + URL explícita.',
      });
    }
    const forceWrite =
      req.query.dry_run === '0' ||
      req.query.dry_run === 'false' ||
      req.body?.dry_run === false ||
      req.body?.dryRun === false;
    const reallyDry = !forceWrite;
    const modeRaw = String(req.query.mode || req.body?.mode || 'flags_stage').trim();
    const mode = ['flags_stage', 'fields', 'both'].includes(modeRaw) ? modeRaw : 'flags_stage';
    const maxDeals = Number(req.query.max || req.body?.max || req.body?.maxDeals) || undefined;
    const asyncMode =
      req.query.async === '1' || req.query.async === 'true' || req.body?.async === true;

    if (reallyDry) {
      const preview = await runFlagsStageSync({
        dryRun: true,
        mode,
        maxDeals: maxDeals || 500,
      });
      return res.json(preview);
    }

    // Write gate: FLAGS_SYNC_ENABLED ou FIELDS_SYNC_ENABLED (fields mode).
    const flagsOn = String(process.env.NOVO_CRM_FLAGS_SYNC_ENABLED || '').trim() === '1';
    const fieldsOn = String(process.env.NOVO_CRM_FIELDS_SYNC_ENABLED || '').trim() === '1';
    if (mode === 'fields' && !fieldsOn && !flagsOn) {
      return res.status(403).json({
        error:
          'NOVO_CRM_FIELDS_SYNC_ENABLED≠1 e FLAGS_SYNC_ENABLED≠1 — escrita bloqueada (dry_run ainda permitido).',
      });
    }
    if ((mode === 'flags_stage' || mode === 'both') && !flagsOn) {
      return res.status(403).json({
        error: 'NOVO_CRM_FLAGS_SYNC_ENABLED≠1 — escrita bloqueada (dry_run ainda permitido).',
      });
    }

    if (isFlagsStageSyncRunning()) {
      return res.status(409).json({ error: 'Sync de flags/etapa já em andamento' });
    }

    if (asyncMode) {
      const started = startFlagsStageSyncBackground({
        dryRun: false,
        mode,
        maxDeals,
      });
      if (!started.started) {
        return res.status(409).json({ error: started.error || 'Já em andamento', jobId: started.jobId });
      }
      return res.status(202).json({
        ok: true,
        status: 'running',
        jobId: started.jobId,
        dry_run: false,
        mode,
      });
    }

    const result = await runFlagsStageSyncLocked({ dryRun: false, mode, maxDeals });
    res.json(result);
  } catch (err) {
    console.error('[sync-flags-stage-novo-crm]', err);
    const status = err?.status && Number(err.status) >= 400 ? Number(err.status) : 500;
    res.status(status).json({ error: err?.message || String(err) });
  }
});

/**
 * GET /api/maintenance/sync-flags-stage-novo-crm-status?jobId=
 */
router.get('/sync-flags-stage-novo-crm-status', requireApiKey, async (req, res) => {
  try {
    const jobId = req.query.jobId ? String(req.query.jobId) : null;
    const job = jobId ? getFlagsStageSyncJob(jobId) : getRunningFlagsStageSyncJob();
    if (!job) {
      return res.json({ ok: true, running: false, job: null });
    }
    res.json({
      ok: true,
      running: job.status === 'running',
      job: {
        jobId: job.jobId,
        mode: job.mode,
        status: job.status,
        dry_run: job.dry_run,
        total: job.total,
        processed: job.processed,
        sent: job.sent,
        phase: job.phase,
        status_message: job.status_message,
        started_at: job.started_at,
        finished_at: job.finished_at,
        result: job.result,
        error: job.error,
      },
    });
  } catch (err) {
    console.error('[sync-flags-stage-novo-crm-status]', err);
    res.status(500).json({ error: err?.message || String(err) });
  }
});

/**
 * GET /api/maintenance/enrich-novo-crm-status?jobId=
 */
router.get('/enrich-novo-crm-status', requireApiKey, async (req, res) => {
  try {
    const jobId = req.query.jobId ? String(req.query.jobId) : null;
    const job = jobId ? getEnrichmentJob(jobId) : getRunningEnrichmentJob();
    if (!job) {
      return res.json({ ok: true, running: false, job: null });
    }
    res.json({
      ok: true,
      running: job.status === 'running',
      job: {
        jobId: job.jobId,
        scope: job.scope,
        status: job.status,
        dry_run: job.dry_run,
        total: job.total,
        processed: job.processed,
        sent: job.sent,
        failed: job.failed,
        skipped: job.skipped,
        phase: job.phase,
        status_message: job.status_message,
        started_at: job.started_at,
        finished_at: job.finished_at,
        error: job.error,
        result: job.result,
      },
    });
  } catch (err) {
    res.status(500).json({ error: err?.message || String(err) });
  }
});

/**
 * POST /api/maintenance/invalidate-datacrazy-cache
 *
 * Invalida entradas do cache. Útil para forçar re-consulta à API.
 *
 * Query: ?all=1       → apaga todo o cache.
 *        ?cpf=<cpf>   → apaga entrada de um CPF específico.
 */
router.post('/invalidate-datacrazy-cache', requireApiKey, async (req, res) => {
  try {
    const cpf = req.query.cpf;
    const all = req.query.all === '1';
    if (all) {
      await query('delete from datacrazy_lead_cache');
      return res.json({ ok: true, invalidated: 'all' });
    }
    if (cpf) {
      await query(
        'delete from datacrazy_lead_cache where cpf = $1',
        [String(cpf).replace(/\D/g, '')]
      );
      return res.json({ ok: true, invalidated: cpf });
    }
    res.status(400).json({ error: 'cpf or all=1 required' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * POST /api/maintenance/backfill-response-identity
 *
 * Preenche consultor_responsavel_nome, rgm, master_key, datacrazy_lead_id e
 * origem_ativacao faltantes em `activation_responses` usando raw_payload,
 * mv_aluno_por_telefone, datacrazy_lead_cache e activation_dispatch_events.
 *
 * Query:
 *   ?days=N       → janela em dias (default 30)
 *   ?category=X   → filtra por categoria (ex: processos-caa)
 *
 * Response:
 *   { ok, lead_id_payload, consultor, rgm_payload, rgm_lk, rgm_dispatch,
 *     rgm_cache_lead_id, days, category, ran_at }
 */
router.post('/backfill-response-identity', requireApiKey, async (req, res, next) => {
  try {
    const days = req.query.days ? Math.max(1, parseInt(String(req.query.days), 10) || 30) : 30;
    const category = req.query.category ? String(req.query.category).trim() : null;
    const result = await activationResponseRepo.backfillResponsesMissingIdentity({ days, category });
    res.json({ ok: true, ...result, days, category, ran_at: new Date().toISOString() });
  } catch (err) {
    next(err);
  }
});

/**
 * POST /api/maintenance/sync-response-consultores
 *
 * Backfill consultor de raw_payload + leitura do campo CRM quando vazio.
 * Query: ?days=N (default 30), ?category=processos-caa, ?crm_limit=500
 */
router.post('/sync-response-consultores', requireApiKey, async (req, res, next) => {
  try {
    const days = req.query.days ? Math.max(1, parseInt(String(req.query.days), 10) || 30) : 30;
    const category = req.query.category ? String(req.query.category).trim() : 'processos-caa';
    const crmLimit = req.query.crm_limit
      ? Math.min(Math.max(parseInt(String(req.query.crm_limit), 10) || 500, 1), 2000)
      : 500;
    const result = await syncResponseConsultores({ days, category, crm_limit: crmLimit });
    res.json({ ok: true, ...result });
  } catch (err) {
    next(err);
  }
});

/**
 * POST /api/maintenance/migrate-meu-painel-legacy
 *
 * Snapshot idempotente de activation_responses + outcomes manuais →
 * meu_painel_legacy_outcomes (leitura no Meu Painel Novo CRM).
 */
router.post('/migrate-meu-painel-legacy', requireApiKey, async (req, res) => {
  try {
    const result = await migrateMeuPainelLegacyFromLive();
    res.json({ ok: true, ...result, ran_at: new Date().toISOString() });
  } catch (err) {
    res.status(500).json({ error: err?.message || String(err) });
  }
});

export default router;
