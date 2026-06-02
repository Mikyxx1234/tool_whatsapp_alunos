/**
 * Job de limpeza de `origem_ativacao` no CRM DataCrazy.
 *
 * Limpa o campo (PUT value="") para leads que tiveram um SET há mais de
 * `journey_settings.origem_ativacao_stale_hours` (default 72h) e que ainda
 * não foram limpos pelo handshake do n8n (decisão 01/06/2026 em AGENTS.md).
 *
 * Disparado de 2 jeitos (redundância intencional):
 *   1. POST /api/maintenance/clean-stale-origem-ativacao (n8n Schedule Trigger)
 *   2. setInterval(24h) registrado em server/index.js
 *
 * Idempotente: cada CLEAR bem-sucedido vira um novo registro em
 * `activation_origem_ativacao_log` com `origem_value=''`, então a próxima
 * execução não o pega de novo (`not exists` na query de stale).
 */
import * as origemRepo from '../repositories/activationOrigemRepository.js';
import * as journeySettingsRepo from '../repositories/journeySettingsRepository.js';
import { datacrazyClient } from './datacrazyClient.js';
import { createRateLimiter } from '../utils/rateLimiter.js';

/**
 * Rate limiter pro CRM DataCrazy (PUT em campos adicionais).
 * Default conservador 10/s (env DATACRAZY_CRM_RATE_PER_SECOND override).
 * Singleton de módulo — compartilhado entre execuções concorrentes do cleanup
 * (ex.: cron + endpoint manual disparados simultaneamente).
 */
const DATACRAZY_CRM_RATE_PER_SECOND = Math.max(
  1,
  Math.floor(Number(process.env.DATACRAZY_CRM_RATE_PER_SECOND) || 10)
);
const datacrazyCrmLimiter = createRateLimiter(DATACRAZY_CRM_RATE_PER_SECOND, 1000);

/**
 * @param {{ dryRun?: boolean }} [opts]
 * @returns {Promise<{
 *   scanned: number,
 *   cleaned: number,
 *   failed: number,
 *   errors: Array<{ lead_id: string, error: string }>,
 *   stale_window_hours: number,
 *   dry_run: boolean,
 *   ran_at: string
 * }>}
 */
export async function cleanStaleOrigemAtivacao({ dryRun = false } = {}) {
  const settings = await journeySettingsRepo.resolveForTerm(null);
  const hours = Math.max(
    1,
    Math.floor(Number(settings?.origem_ativacao_stale_hours) || 72)
  );

  const stale = await origemRepo.listStaleSetEntries(hours);

  let cleaned = 0;
  let failed = 0;
  /** @type {Array<{ lead_id: string, error: string }>} */
  const errors = [];

  for (const entry of stale) {
    if (dryRun) continue;
    try {
      await datacrazyCrmLimiter.acquire();
      const res = await datacrazyClient.clearOrigemAtivacaoForLead(
        entry.datacrazy_lead_id
      );
      if (res?.ok) {
        await origemRepo.recordOrigemAtivacaoLog({
          category: entry.category,
          origemValue: '',
          datacrazyLeadId: entry.datacrazy_lead_id,
          masterKey: entry.master_key,
          cpf: entry.cpf,
          rgm: entry.rgm,
          nome: entry.nome,
          status: 'ok',
        });
        cleaned += 1;
      } else {
        failed += 1;
        const errMsg = res?.error || 'unknown';
        errors.push({ lead_id: entry.datacrazy_lead_id, error: errMsg });
        await origemRepo
          .recordOrigemAtivacaoLog({
            category: entry.category,
            origemValue: '',
            datacrazyLeadId: entry.datacrazy_lead_id,
            masterKey: entry.master_key,
            cpf: entry.cpf,
            rgm: entry.rgm,
            nome: entry.nome,
            status: 'failed',
            errorMessage: errMsg,
          })
          .catch((logErr) => {
            console.error(
              '[cleanup origem_ativacao] falha ao registrar log do erro:',
              logErr.message
            );
          });
      }
    } catch (err) {
      failed += 1;
      errors.push({ lead_id: entry.datacrazy_lead_id, error: err.message });
    }
  }

  return {
    scanned: stale.length,
    cleaned,
    failed,
    errors: errors.slice(0, 20),
    stale_window_hours: hours,
    crm_rate_per_second: DATACRAZY_CRM_RATE_PER_SECOND,
    dry_run: dryRun,
    ran_at: new Date().toISOString(),
  };
}
