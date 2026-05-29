import { withTransaction } from '../db/client.js';
import * as campaignRepo from '../repositories/campaignRepository.js';
import * as campaignTypeRepo from '../repositories/campaignTypeRepository.js';
import * as contactRepo from '../repositories/contactRepository.js';
import * as eventRepo from '../repositories/eventRepository.js';

/**
 * Cria uma campanha em status 'draft'. O fluxo recomendado é:
 *   1) createCampaign()
 *   2) addContacts()      — popula whatsapp_campaign_contacts
 *   3) markReady()        — calcula totais e muda para 'ready'
 *   4) campaignQueueService.start() — efetua os disparos
 */
export async function createCampaign(input) {
  const {
    name,
    description,
    campaignTypeCode,
    campaignTypeId,
    templateName,
    templateLanguage,
    templateCategory,
    sourceFileName,
    intervalSeconds,
    dailyLimit,
    createdBy,
  } = input;

  if (!name || !name.trim()) {
    const err = new Error('Campo "name" é obrigatório.');
    err.status = 400;
    throw err;
  }

  let typeId = campaignTypeId || null;
  if (!typeId && campaignTypeCode) {
    const type = await campaignTypeRepo.findByCode(campaignTypeCode);
    if (!type) {
      const err = new Error(`Tipo de campanha "${campaignTypeCode}" não encontrado.`);
      err.status = 400;
      throw err;
    }
    typeId = type.id;
  }
  if (!typeId) {
    const err = new Error('Informe campaignTypeCode (ou campaignTypeId).');
    err.status = 400;
    throw err;
  }

  return withTransaction(async (client) => {
    const campaign = await campaignRepo.create(
      {
        campaignTypeId: typeId,
        name: name.trim(),
        description,
        templateName,
        templateLanguage,
        templateCategory,
        sourceFileName,
        intervalSeconds,
        dailyLimit,
        status: 'draft',
        createdBy,
      },
      client
    );
    await eventRepo.record(
      {
        campaignId: campaign.id,
        eventType: 'campaign_created',
        eventMessage: `Campanha "${campaign.name}" criada.`,
        metadata: { templateName, campaignTypeId: typeId },
      },
      client
    );
    return campaign;
  });
}

/**
 * Adiciona contatos (já validados pelo frontend) à campanha.
 * Reabsorve duplicatas via unique index e re-classifica como 'duplicate'.
 */
export async function addContacts(campaignId, contacts, sourceFileName) {
  const campaign = await campaignRepo.findById(campaignId);
  if (!campaign) {
    const err = new Error('Campanha não encontrada.');
    err.status = 404;
    throw err;
  }
  if (!['draft', 'validating'].includes(campaign.status)) {
    const err = new Error(
      `Não é possível adicionar contatos em uma campanha com status "${campaign.status}".`
    );
    err.status = 409;
    throw err;
  }

  await campaignRepo.updateStatus(campaignId, 'validating', {
    source_file_name: sourceFileName || campaign.source_file_name,
  });

  await eventRepo.record({
    campaignId,
    eventType: 'csv_uploaded',
    metadata: { count: contacts.length, sourceFileName },
  });
  await eventRepo.record({
    campaignId,
    eventType: 'validation_started',
    metadata: { count: contacts.length },
  });

  const inserted = await contactRepo.bulkInsert(campaignId, contacts);
  const sameTemplateDupes = await contactRepo.markDuplicatesSameTemplateAlreadySent(
    campaignId,
    {
      templateName: campaign.template_name,
      templateLanguage: campaign.template_language,
    }
  );
  const updated = await campaignRepo.refreshTotalsFromContacts(campaignId);

  await campaignRepo.updateStatus(campaignId, 'ready');
  await eventRepo.record({
    campaignId,
    eventType: 'validation_completed',
    metadata: {
      inserted: inserted.length,
      total_contacts: updated.total_contacts,
      total_valid: updated.total_valid,
      total_invalid: updated.total_invalid,
      total_duplicates: updated.total_duplicates,
      same_template_marked_duplicate: sameTemplateDupes,
    },
  });

  return {
    insertedCount: inserted.length,
    campaign: await campaignRepo.findSummaryById(campaignId),
  };
}

export async function getCampaign(id) {
  const campaign = await campaignRepo.findSummaryById(id);
  if (!campaign) {
    const err = new Error('Campanha não encontrada.');
    err.status = 404;
    throw err;
  }
  return campaign;
}

export async function listCampaigns(options) {
  return campaignRepo.listSummary(options);
}

export async function listCampaignContacts(campaignId, options) {
  return contactRepo.listByCampaign(campaignId, options);
}

export async function markNotInteracted(campaignId, hoursAfterSend = 24) {
  const updated = await contactRepo.markNotInteracted(campaignId, hoursAfterSend);
  await campaignRepo.refreshTotalsFromContacts(campaignId);
  await eventRepo.record({
    campaignId,
    eventType: 'mark_not_interacted',
    metadata: { hoursAfterSend, updated },
  });
  return { updated };
}
