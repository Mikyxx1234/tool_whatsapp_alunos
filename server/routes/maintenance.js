/**
 * Rotas de manutenção operacional. Protegidas por requireApiKey (decisão de
 * 26/05/2026 — hardening).
 */
import { Router } from 'express';
import { requireApiKey } from '../middleware/requireApiKey.js';
import { cleanStaleOrigemAtivacao } from '../services/activationOrigemCleanupService.js';
import { syncCaaDesfechos } from '../services/crmDesfechoSyncService.js';

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

export default router;
