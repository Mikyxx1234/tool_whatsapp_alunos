/**
 * Warm cirúrgico do espelho a partir do CRM ao vivo.
 *
 * Usado quando o full sync deixou um contact sem os deals que ele tem no CRM
 * (índice em lote perde registros por deriva de paginação). Não altera o CRM.
 */

import * as apiSourceRepo from '../repositories/novoCrmPersonApiSourceRepository.js';
import * as cacheRepo from '../repositories/novoCrmPersonCacheRepository.js';
import { getContact } from './novoCrmClient.js';

/**
 * Sincroniza um contact (com seus deals e campos) para o espelho local.
 * @param {object|string} contactOrId — objeto do contact ou o id
 * @param {{ fetchFields?: boolean }} [opts]
 * @returns {Promise<{ contactId: string, deals: number }>}
 */
export async function warmContactFromLive(contactOrId, opts = {}) {
  const fetchFields = opts.fetchFields !== false;
  let contact = typeof contactOrId === 'object' && contactOrId ? contactOrId : null;
  const contactId = String(contact?.id || contactOrId || '').trim();
  if (!contactId) throw new Error('warmContactFromLive: contactId ausente');
  if (!contact) contact = await getContact(contactId);
  if (!contact?.id) throw new Error(`warmContactFromLive: contact ${contactId} não encontrado`);

  const deals = await apiSourceRepo.listDealsForContactId(contactId);
  const details = fetchFields
    ? await apiSourceRepo.fetchDealDetailsByIds(
        deals.map((d) => String(d.id)).filter(Boolean),
        { concurrency: 2, delayMs: 0 }
      )
    : new Map();
  const snapshot = apiSourceRepo.mapApiSnapshot(contact, deals, details);
  await cacheRepo.upsertSnapshot(snapshot, { syncLogId: null, fullSeenAt: null });
  return { contactId, deals: deals.length };
}
