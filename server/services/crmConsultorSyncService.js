/**
 * Sync de consultor responsável: backfill do payload + leitura do CRM DataCrazy.
 *
 * Dois caminhos:
 *   1. POST /api/maintenance/sync-response-consultores
 *   2. setInterval a cada CRM_CONSULTOR_SYNC_INTERVAL_HOURS (default 2h)
 */
import {
  backfillResponsesMissingIdentity,
  syncConsultorFromCrmForResponses,
} from '../repositories/activationResponseRepository.js';

/**
 * @param {{ days?: number, category?: string|null, crm_limit?: number }} [opts]
 */
export async function syncResponseConsultores(opts = {}) {
  const days = opts.days ?? 30;
  const category = opts.category ?? 'processos-caa';
  const crmLimit = opts.crm_limit ?? 500;

  const backfill = await backfillResponsesMissingIdentity({ days, category });
  const crm = await syncConsultorFromCrmForResponses({
    days,
    category,
    limit: crmLimit,
  });

  return {
    backfill,
    crm,
    ran_at: new Date().toISOString(),
  };
}
