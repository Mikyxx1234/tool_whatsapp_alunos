/**
 * Sync de desfechos CAA via campo do CRM DataCrazy.
 *
 * O consultor preenche o campo `DATACRAZY_DESFECHO_CAA_FIELD_ID` no lead com
 * "Sim" (matrícula revertida) ou "Não" (cancelamento confirmado). Este serviço
 * lê esse campo para cada lead CAA disparado recentemente, cria a entrada em
 * `activation_manual_outcomes` e limpa o campo no CRM (handshake).
 *
 * Dois caminhos de execução (redundância intencional):
 *   1. POST /api/maintenance/sync-crm-desfechos (endpoint manual / n8n)
 *   2. setInterval a cada CRM_DESFECHO_SYNC_INTERVAL_HOURS (default 2h)
 */
import { datacrazyClient } from './datacrazyClient.js';
import {
  listRecentDispatchedLeadsForCategory,
} from '../repositories/activationDispatchRepository.js';
import {
  deleteByRgmAndCategory,
  createFromCrm,
} from '../repositories/manualOutcomesRepository.js';
import { query } from '../db/client.js';
import {
  datacrazyCrmLimiter,
  DATACRAZY_CRM_RATE_PER_SECOND,
} from '../utils/datacrazyCrmLimiter.js';

const DESFECHO_FIELD_ID = process.env.DATACRAZY_DESFECHO_CAA_FIELD_ID || '';
const DEFAULT_LOOKBACK_DAYS = Math.max(
  1,
  parseInt(process.env.CRM_DESFECHO_SYNC_LOOKBACK_DAYS || '14', 10) || 14
);

function parseOutcome(raw) {
  if (!raw) return null;
  const v = raw.trim().toLowerCase();
  if (v === 'sim') return 'revertido';
  if (v === 'não' || v === 'nao') return 'confirmado';
  return null;
}

async function logSync(entry) {
  try {
    await query(
      `insert into crm_desfecho_sync_log
         (datacrazy_lead_id, rgm, field_value, outcome_created, overwrote_manual_id, error)
       values ($1, $2, $3, $4, $5, $6)`,
      [
        entry.datacrazy_lead_id,
        entry.rgm ?? null,
        entry.field_value ?? null,
        entry.outcome_created ?? null,
        entry.overwrote_manual_id ?? null,
        entry.error ?? null,
      ]
    );
  } catch (logErr) {
    console.error('[crm-desfecho-sync] falha ao gravar log:', logErr.message);
  }
}

/**
 * @param {{ dryRun?: boolean, days?: number|null }} [opts]
 * @returns {Promise<{
 *   scanned: number,
 *   synced_revertido: number,
 *   synced_confirmado: number,
 *   ignored: number,
 *   failed: number,
 *   errors: Array<{ lead_id: string, error: string }>,
 *   lookback_days: number,
 *   dry_run: boolean,
 *   ran_at: string,
 *   crm_rate_per_second: number,
 *   skipped_no_config?: boolean,
 * }>}
 */
export async function syncCaaDesfechos({ dryRun = false, days = null } = {}) {
  if (!DESFECHO_FIELD_ID) {
    console.warn(
      '[crm-desfecho-sync] DATACRAZY_DESFECHO_CAA_FIELD_ID não configurado — sync ignorado.'
    );
    return {
      scanned: 0,
      synced_revertido: 0,
      synced_confirmado: 0,
      ignored: 0,
      failed: 0,
      errors: [],
      lookback_days: DEFAULT_LOOKBACK_DAYS,
      dry_run: dryRun,
      ran_at: new Date().toISOString(),
      crm_rate_per_second: DATACRAZY_CRM_RATE_PER_SECOND,
      skipped_no_config: true,
    };
  }

  const lookbackDays = days
    ? Math.max(1, Math.floor(Number(days) || DEFAULT_LOOKBACK_DAYS))
    : DEFAULT_LOOKBACK_DAYS;

  const leads = await listRecentDispatchedLeadsForCategory('processos-caa', lookbackDays);

  let synced_revertido = 0;
  let synced_confirmado = 0;
  let ignored = 0;
  let failed = 0;
  /** @type {Array<{ lead_id: string, error: string }>} */
  const errors = [];

  for (const lead of leads) {
    try {
      await datacrazyCrmLimiter.acquire();
      const raw = await datacrazyClient.getLeadAdditionalFieldValue(
        lead.datacrazy_lead_id,
        DESFECHO_FIELD_ID
      );

      const outcome = parseOutcome(raw);

      if (!outcome) {
        ignored += 1;
        if (raw !== null && raw.trim() !== '') {
          await logSync({
            datacrazy_lead_id: lead.datacrazy_lead_id,
            rgm: lead.rgm,
            field_value: raw,
            outcome_created: null,
          });
        }
        continue;
      }

      if (dryRun) {
        if (outcome === 'revertido') synced_revertido += 1;
        else synced_confirmado += 1;
        continue;
      }

      // Sobrescreve desfechos manuais existentes do mesmo RGM/categoria
      let overwriteId = null;
      if (lead.rgm) {
        const deleted = await deleteByRgmAndCategory(lead.rgm, 'processos-caa');
        if (deleted.length > 0) {
          overwriteId = deleted[0].id;
        }
      }

      const isoNow = new Date().toISOString();
      await createFromCrm({
        category: 'processos-caa',
        rgm: lead.rgm,
        datacrazy_lead_id: lead.datacrazy_lead_id,
        nome: lead.nome,
        outcome,
        motivo: `Importado do CRM em ${isoNow}`,
        notes: `Valor do campo: ${raw}`,
        occurred_at: new Date(),
      });

      // Limpa o campo no CRM (handshake — evita reprocessar na próxima rodada)
      await datacrazyCrmLimiter.acquire();
      await datacrazyClient.updateLeadAdditionalField(
        lead.datacrazy_lead_id,
        DESFECHO_FIELD_ID,
        ''
      );

      await logSync({
        datacrazy_lead_id: lead.datacrazy_lead_id,
        rgm: lead.rgm,
        field_value: raw,
        outcome_created: outcome,
        overwrote_manual_id: overwriteId,
      });

      if (outcome === 'revertido') synced_revertido += 1;
      else synced_confirmado += 1;
    } catch (err) {
      failed += 1;
      errors.push({ lead_id: lead.datacrazy_lead_id, error: err.message });
      await logSync({
        datacrazy_lead_id: lead.datacrazy_lead_id,
        rgm: lead.rgm,
        error: err.message,
      });
    }
  }

  return {
    scanned: leads.length,
    synced_revertido,
    synced_confirmado,
    ignored,
    failed,
    errors: errors.slice(0, 20),
    lookback_days: lookbackDays,
    dry_run: dryRun,
    ran_at: new Date().toISOString(),
    crm_rate_per_second: DATACRAZY_CRM_RATE_PER_SECOND,
  };
}
