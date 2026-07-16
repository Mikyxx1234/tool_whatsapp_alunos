/**
 * Batch de ativação via tag no CRM EduIT (sem WhatsApp).
 * Reusa fila/cooldown/master_key e grava activation_dispatch_events (channel novo_crm_tag).
 */
import * as activationDispatchRepo from '../repositories/activationDispatchRepository.js';
import { isJobCancelled } from './activationJobsRegistry.js';
import {
  activateByCategoryTag,
  isNovoCrmApiConfigured,
  tagNameForCategory,
} from './novoCrmClient.js';
import { createRateLimiter } from '../utils/rateLimiter.js';
import * as cacheRepo from '../repositories/novoCrmPersonCacheRepository.js';
import * as sourceRepo from '../repositories/novoCrmPersonSourceRepository.js';
import {
  normalizeCpf,
  normalizeEmail,
  normalizePhone,
  normalizeRgm,
} from '../utils/novoCrmCacheNormalize.js';

const TAG_OPS_PER_SECOND = Math.max(
  1,
  Math.floor(Number(process.env.NOVO_CRM_TAG_OPS_PER_SECOND) || 8)
);
const tagOpLimiter = createRateLimiter(TAG_OPS_PER_SECOND, 1000);

async function resolveBatchFromCacheWithDbFallback(items) {
  let resolved = await cacheRepo.resolveActivationBatch(items);
  const misses = [];
  for (let i = 0; i < items.length; i++) {
    const r = resolved.get(i);
    if (!r || r.status === 'not_found') misses.push({ item: items[i], index: i });
  }
  if (!misses.length) return resolved;

  const phones = misses.map((m) => normalizePhone(m.item?.telefone || m.item?.phone)).filter(Boolean);
  const emails = misses.map((m) => normalizeEmail(m.item?.email)).filter(Boolean);
  const cpfs = misses.map((m) => normalizeCpf(m.item?.cpf)).filter(Boolean);
  const rgms = misses.map((m) => normalizeRgm(m.item?.rgm)).filter(Boolean);

  try {
    const contactIds = await sourceRepo.findContactIdsByLookup({ phones, emails, cpfs, rgms });
    if (contactIds.length) {
      const snapshots = await sourceRepo.loadSnapshotsByContactIds(contactIds);
      for (const snapshot of snapshots) {
        await cacheRepo.upsertSnapshot(snapshot, { syncLogId: null, fullSeenAt: null });
      }
      resolved = await cacheRepo.resolveActivationBatch(items);
    }
  } catch (err) {
    // Fallback não deve derrubar o lote: se o CRM DB estiver indisponível, segue
    // com o estado atual do cache local e reporta not_found nos misses.
    console.warn('[novo-crm-tag] fallback DB lookup indisponível:', err?.message || String(err));
  }
  return resolved;
}

/**
 * @param {string} category
 * @param {object[]} toProcess
 * @param {object} [opts]
 * @param {object} [callbacks]
 */
export async function runNovoCrmTagActivationBatch(category, toProcess, opts = {}, callbacks = {}) {
  const onProgress = typeof callbacks.onProgress === 'function' ? callbacks.onProgress : () => {};
  const onTotal = typeof callbacks.onTotal === 'function' ? callbacks.onTotal : () => {};

  if (!isNovoCrmApiConfigured()) {
    const err = new Error(
      'Novo CRM não configurado. Defina NOVO_CRM_ENABLED=1 e NOVO_CRM_API_TOKEN.'
    );
    err.status = 503;
    throw err;
  }
  if (!tagNameForCategory(category)) {
    const err = new Error(`Categoria sem tag de ativação: ${category}`);
    err.status = 400;
    throw err;
  }

  const jobId = opts.jobId;
  const throwIfCancelled = () => {
    if (isJobCancelled(jobId)) {
      const err = new Error('Cancelado pelo operador');
      err.code = 'cancelled';
      throw err;
    }
  };

  onTotal({ total: toProcess.length });
  onProgress({
    processed: 0,
    phase: 'lookup',
    status_message: 'Localizando contacts no cache do Novo CRM…',
  });

  let sent = 0;
  let notFound = 0;
  let failed = 0;
  let skipped = 0;
  /** @type {object[]} */
  const notFoundItems = [];
  /** @type {object[]} */
  const results = [];

  const resolvedByIndex = await resolveBatchFromCacheWithDbFallback(toProcess);

  for (let i = 0; i < toProcess.length; i++) {
    throwIfCancelled();
    const item = toProcess[i];
    const masterKey = item.master_key || null;

    try {
      const resolved = resolvedByIndex.get(i);
      if (!resolved || resolved.status !== 'ok' || !resolved.contactId) {
        notFound += 1;
        const reason = resolved?.reason || 'contact_not_found_novo_crm_cache';
        notFoundItems.push({
          master_key: masterKey,
          nome: item.nome ?? null,
          telefone: item.telefone ?? null,
          email: item.email ?? null,
          rgm: item.rgm ?? null,
          cpf: item.cpf ?? null,
          reason,
          candidates: resolved?.candidates || undefined,
        });
        await activationDispatchRepo.recordDispatchEvent({
          category,
          masterKey,
          status: 'not_found',
          channel: 'novo_crm_tag',
          nome: item.nome ?? null,
          telefone: item.telefone ?? null,
          email: item.email ?? null,
          rgm: item.rgm ?? null,
          errorMessage:
            String(reason).startsWith('ambiguous_match')
              ? 'Match ambíguo no cache do Novo CRM'
              : `Contact não encontrado no cache do Novo CRM (${reason})`,
        });
        results.push({ master_key: masterKey, status: 'not_found' });
      } else {
        await tagOpLimiter.acquire();
        const act = await activateByCategoryTag({
          contactId: resolved.contactId,
          dealId: resolved.dealId,
          category,
          masterKey,
          cpf: item.cpf ?? null,
          rgm: item.rgm ?? null,
          nome: item.nome ?? null,
        });
        sent += 1;
        await activationDispatchRepo.recordDispatchEvent({
          category,
          masterKey,
          status: 'sent',
          channel: 'novo_crm_tag',
          templateName: act.tagName,
          datacrazyLeadId: resolved.contactId,
          nome: item.nome ?? null,
          telefone: item.telefone ?? null,
          email: item.email ?? null,
          rgm: item.rgm ?? null,
        });
        results.push({
          master_key: masterKey,
          status: 'sent',
          contact_id: resolved.contactId,
          deal_id: resolved.dealId,
          tag_name: act.tagName,
        });
      }
    } catch (err) {
      failed += 1;
      const errMsg = err?.message || String(err);
      await activationDispatchRepo
        .recordDispatchEvent({
          category,
          masterKey,
          status: 'failed',
          channel: 'novo_crm_tag',
          nome: item.nome ?? null,
          telefone: item.telefone ?? null,
          email: item.email ?? null,
          rgm: item.rgm ?? null,
          errorMessage: errMsg,
        })
        .catch(() => {});
      results.push({ master_key: masterKey, status: 'failed', error: errMsg });
    }

    onProgress({
      processed: i + 1,
      sent,
      not_found: notFound,
      failed,
      skipped,
      phase: 'sending',
      status_message: `Tags: ${sent} ok · ${notFound} não encontrados · ${failed} falhas`,
    });
  }

  return {
    category,
    processed: toProcess.length,
    sent,
    not_found: notFound,
    failed,
    rate_limited: 0,
    skipped,
    not_found_items: notFoundItems,
    results,
    datacrazy_pages: 0,
    datacrazy_leads_scanned: 0,
    origem_ativacao_blocked: false,
    origem_ativacao_error: null,
    message: `Ativação por tag (Novo CRM): ${sent} tagueados, ${notFound} não encontrados, ${failed} falhas.`,
    mode: 'novo_crm_tag',
  };
}
