/**
 * Job de limpeza de tags de ativação (ativacao-*) no CRM EduIT.
 *
 * Espelha cleanStaleOrigemAtivacao: REMOVE a tag via API para SETs no log local
 * há mais de journey_settings.origem_ativacao_stale_hours (default 72h) sem CLEAR.
 *
 * Contato sempre; deal quando deal_id estiver no log.
 */
import * as tagLogRepo from '../repositories/activationNovoCrmTagRepository.js';
import * as journeySettingsRepo from '../repositories/journeySettingsRepository.js';
import {
  isNovoCrmApiConfigured,
  removeTagFromContact,
  removeTagFromDeal,
  resolveTagIdByName,
} from './novoCrmClient.js';

/**
 * @param {{ dryRun?: boolean }} [opts]
 */
export async function cleanStaleActivationTags({ dryRun = false } = {}) {
  const settings = await journeySettingsRepo.resolveForTerm(null);
  const hours = Math.max(
    1,
    Math.floor(Number(settings?.origem_ativacao_stale_hours) || 72)
  );

  if (!isNovoCrmApiConfigured() && !dryRun) {
    return {
      scanned: 0,
      cleaned: 0,
      failed: 0,
      errors: [],
      stale_window_hours: hours,
      dry_run: dryRun,
      skipped_no_config: true,
      ran_at: new Date().toISOString(),
    };
  }

  const stale = await tagLogRepo.listStaleSetEntries(hours);

  let cleaned = 0;
  let failed = 0;
  /** @type {Array<{ contact_id: string, tag_name: string, error: string }>} */
  const errors = [];

  for (const entry of stale) {
    if (dryRun) continue;
    const contactId = String(entry.contact_id || '').trim();
    const tagName = String(entry.tag_name || '').trim();
    let tagId = entry.tag_id ? String(entry.tag_id).trim() : '';
    const dealId = entry.deal_id ? String(entry.deal_id).trim() : null;

    try {
      if (!tagId) {
        tagId = (await resolveTagIdByName(tagName)) || '';
      }
      const tagRef = tagId ? { tagId } : { tagName };

      await removeTagFromContact(contactId, tagRef);
      if (dealId) {
        try {
          await removeTagFromDeal(dealId, tagRef);
        } catch (dealErr) {
          // Contact já limpo — deal é best-effort (pode não ter a tag).
          console.warn(
            `[cleanup activation-tags] deal ${dealId}:`,
            dealErr?.message || dealErr
          );
        }
      }

      await tagLogRepo.recordTagLog({
        category: entry.category,
        tagName,
        tagId: tagId || null,
        tagValue: '',
        contactId,
        dealId,
        masterKey: entry.master_key ?? null,
        cpf: entry.cpf ?? null,
        rgm: entry.rgm ?? null,
        nome: entry.nome ?? null,
        status: 'ok',
      });
      cleaned += 1;
    } catch (err) {
      failed += 1;
      const errMsg = err?.message || String(err);
      errors.push({ contact_id: contactId, tag_name: tagName, error: errMsg });
      await tagLogRepo
        .recordTagLog({
          category: entry.category,
          tagName,
          tagId: tagId || null,
          tagValue: '',
          contactId,
          dealId,
          masterKey: entry.master_key ?? null,
          cpf: entry.cpf ?? null,
          rgm: entry.rgm ?? null,
          nome: entry.nome ?? null,
          status: 'failed',
          errorMessage: errMsg,
        })
        .catch((logErr) => {
          console.error(
            '[cleanup activation-tags] falha ao registrar log do erro:',
            logErr.message
          );
        });
    }
  }

  return {
    scanned: stale.length,
    cleaned: dryRun ? 0 : cleaned,
    failed,
    errors: errors.slice(0, 20),
    stale_window_hours: hours,
    dry_run: dryRun,
    skipped_no_config: false,
    ran_at: new Date().toISOString(),
  };
}
