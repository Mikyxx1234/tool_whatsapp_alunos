/**
 * Backfill Atualizado?=Sim nos deals do cache que casam com matriculados.
 *
 * Uso:
 *   node --env-file=.env scripts/novo-crm-backfill-atualizado.mjs --dry --max=50
 *   node --env-file=.env scripts/novo-crm-backfill-atualizado.mjs --apply
 *   node --env-file=.env scripts/novo-crm-backfill-atualizado.mjs --apply --all-deals
 *
 * Default: só deals matched com matriculados (filtro operacional).
 * --all-deals: qualquer deal do cache (não recomendado).
 */
import fs from 'node:fs';
import path from 'node:path';
import { applyNovoCrmProdIdsFromFile } from './_applyNovoCrmProdIds.mjs';
import * as baseUploadRepo from '../server/repositories/baseUploadRepository.js';
import * as cacheRepo from '../server/repositories/novoCrmPersonCacheRepository.js';
import { extractMatriculadosMappedValues } from '../server/utils/novoCrmFieldMapping.js';
import {
  normalizeCpf,
  normalizeEmail,
  normalizePhone,
  normalizeRgm,
} from '../server/utils/novoCrmCacheNormalize.js';
import { getNovoCrmDealFieldIds } from '../server/utils/novoCrmStageRules.js';
import { updateDealCustomFields } from '../server/services/novoCrmClient.js';
import { isNovoCrmWriteAllowedOnThisHost } from '../server/services/novoCrmMatriculadosProvisionService.js';

const args = process.argv.slice(2);
const apply = args.includes('--apply');
const allDeals = args.includes('--all-deals');
const maxArg = args.find((a) => a.startsWith('--max='));
const skipArg = args.find((a) => a.startsWith('--skip='));
const maxDeals = Math.min(
  Math.max(Number(maxArg?.split('=')[1]) || (apply ? 100000 : 100), 1),
  100000
);
const skipDeals = Math.max(Number(skipArg?.split('=')[1]) || 0, 0);
const concurrency = Math.min(
  Math.max(Number(process.env.NOVO_CRM_BACKFILL_CONCURRENCY || 4), 1),
  10
);

process.env.NOVO_CRM_ENABLED = '1';
process.env.NOVO_CRM_CACHE_SOURCE = process.env.NOVO_CRM_CACHE_SOURCE || 'api';
process.env.NOVO_CRM_PROVISION_ALLOW_PROD = '1';
if (!process.env.NOVO_CRM_API_RATE_PER_SECOND) {
  process.env.NOVO_CRM_API_RATE_PER_SECOND = '5';
}

const ids = applyNovoCrmProdIdsFromFile();
const fieldIds = getNovoCrmDealFieldIds();
const fieldId = String(fieldIds.atualizado || ids?.fields?.NOVO_CRM_FIELD_ATUALIZADO || '').trim();
const base = String(process.env.NOVO_CRM_API_BASE_URL || '').trim();

const logPath = path.resolve(`data/backfill-atualizado-${Date.now()}.log`);
const summaryPath = logPath.replace(/\.log$/, '-summary.json');
fs.mkdirSync('data', { recursive: true });
function log(...parts) {
  const line = `[${new Date().toISOString()}] ${parts.map(String).join(' ')}`;
  console.log(line);
  fs.appendFileSync(logPath, `${line}\n`);
}

function findCustom(deal, names) {
  const wanted = names.map((n) => n.toLowerCase());
  for (const f of deal?.customFields || []) {
    const name = String(f?.name || '')
      .trim()
      .toLowerCase();
    if (wanted.includes(name) && f?.value != null && String(f.value).trim() !== '') {
      return String(f.value).trim();
    }
  }
  return '';
}

function dealsFromCacheRow(row) {
  const raw = row?.raw_data || {};
  const byId = raw.dealsById && typeof raw.dealsById === 'object' ? raw.dealsById : {};
  const list = Object.values(byId);
  if (list.length) return list;
  if (row.primary_deal_id) {
    return [{ id: String(row.primary_deal_id), stageId: null, customFields: [] }];
  }
  return [];
}

function keepBestRow(map, key, row) {
  if (!key) return;
  if (!map.has(key)) map.set(key, row);
}

function isSimValue(v) {
  const s = String(v ?? '')
    .trim()
    .toLowerCase();
  return s === 'sim' || s === 'true' || s === '1' || s === 'yes';
}

if (!base || base.includes('crm-dev')) {
  log('ABORT base inválida', base);
  process.exit(2);
}
if (!fieldId || fieldId === '-') {
  log('ABORT NOVO_CRM_FIELD_ATUALIZADO ausente');
  process.exit(2);
}
if (apply && !isNovoCrmWriteAllowedOnThisHost()) {
  log('ABORT write não permitido neste host');
  process.exit(1);
}

log(
  'START',
  JSON.stringify({
    base,
    fieldId,
    apply,
    allDeals,
    maxDeals,
    skipDeals,
    concurrency,
    rate: process.env.NOVO_CRM_API_RATE_PER_SECOND,
  })
);

const byCpf = new Map();
const byRgm = new Map();
const byEmail = new Map();
const byPhone = new Map();
const emailRowCount = new Map();
const phoneRowCount = new Map();

if (!allDeals) {
  const matSnap = await baseUploadRepo.getLatestSnapshot('matriculados');
  if (!matSnap?.id) {
    log('ABORT snapshot matriculados ausente');
    process.exit(1);
  }
  log('matriculados', matSnap.id, matSnap.file_name || '');
  await baseUploadRepo.forEachRowDataForSnapshot('matriculados', matSnap.id, (row) => {
    const m = extractMatriculadosMappedValues(row);
    const cpf = normalizeCpf(m.cpf);
    const rgm = normalizeRgm(m.rgm);
    if (cpf) keepBestRow(byCpf, cpf, row);
    if (rgm) keepBestRow(byRgm, rgm, row);
    const rowEmails = new Set(
      [normalizeEmail(m._email), normalizeEmail(m.e_mail_ad)].filter(Boolean)
    );
    for (const email of rowEmails) {
      emailRowCount.set(email, (emailRowCount.get(email) || 0) + 1);
      keepBestRow(byEmail, email, row);
    }
    const phone = normalizePhone(m._phone || m.telefone_comercial);
    if (phone) {
      phoneRowCount.set(phone, (phoneRowCount.get(phone) || 0) + 1);
      keepBestRow(byPhone, phone, row);
    }
  });
  for (const [email, n] of emailRowCount) if (n > 1) byEmail.delete(email);
  for (const [phone, n] of phoneRowCount) if (n > 1) byPhone.delete(phone);
  log(`index cpf=${byCpf.size} rgm=${byRgm.size} email=${byEmail.size} phone=${byPhone.size}`);
}

const cacheRows = await cacheRepo.listActiveCacheRowsForEnrichment({
  scope: 'all_mapped',
  limit: 100000,
});
log('cache rows', cacheRows.length);

/** @type {string[]} */
const queue = [];
let alreadySim = 0;
let skippedNoMatch = 0;
let scanned = 0;

for (const row of cacheRows) {
  const deals = dealsFromCacheRow(row);
  if (!deals.length) continue;
  const cpfCache = normalizeCpf(row.cpf_norm);
  const emailCache = normalizeEmail(row.email_norm);
  const phoneCache = normalizePhone(row.phone_norm);

  for (const deal of deals) {
    scanned += 1;
    const dealId = String(deal?.id || '').trim();
    if (!dealId) continue;

    if (!allDeals) {
      const rgmDeal = normalizeRgm(findCustom(deal, ['rgm']) || row.rgm_norm);
      const cpfDeal = normalizeCpf(findCustom(deal, ['cpf']) || cpfCache);
      const matRow =
        (rgmDeal && byRgm.get(rgmDeal)) ||
        (cpfDeal && byCpf.get(cpfDeal)) ||
        (emailCache && byEmail.get(emailCache)) ||
        (phoneCache && byPhone.get(phoneCache)) ||
        null;
      if (!matRow) {
        skippedNoMatch += 1;
        continue;
      }
    }

    const cur = findCustom(deal, ['atualizado?', 'atualizado']);
    if (isSimValue(cur)) {
      alreadySim += 1;
      continue;
    }

    queue.push(dealId);
    if (queue.length >= maxDeals + skipDeals) break;
  }
  if (queue.length >= maxDeals + skipDeals) break;
}

const fullQueueLen = queue.length;
if (skipDeals > 0) {
  queue.splice(0, Math.min(skipDeals, queue.length));
}

log(
  `queue=${queue.length} skipped_offset=${skipDeals} built=${fullQueueLen} alreadySim=${alreadySim} skippedNoMatch=${skippedNoMatch} scanned=${scanned}`
);

if (!apply) {
  const summary = {
    ok: true,
    dry_run: true,
    fieldId,
    queue: queue.length,
    alreadySim,
    skippedNoMatch,
    scanned,
    sample_deal_ids: queue.slice(0, 20),
  };
  fs.writeFileSync(summaryPath, JSON.stringify(summary, null, 2));
  log('DRY DONE', JSON.stringify(summary));
  process.exit(0);
}

let written = 0;
let errors = 0;
const errorSamples = [];
let cursor = 0;
const started = Date.now();
const errorBudget = Math.min(
  Math.max(Number(process.env.NOVO_CRM_FLAGS_SYNC_MAX_ERRORS || 500), 50),
  5000
);

async function worker() {
  while (errors < errorBudget) {
    const i = cursor++;
    if (i >= queue.length) return;
    const dealId = queue[i];
    try {
      await updateDealCustomFields(dealId, [{ fieldId, value: 'Sim' }], { maxRetries: 4 });
      written += 1;
    } catch (err) {
      errors += 1;
      if (errorSamples.length < 20) {
        errorSamples.push({ dealId, error: String(err?.message || err) });
      }
    }
    if ((written + errors) % 1000 === 0 || i + 1 === queue.length) {
      const done = written + errors;
      const mins = ((Date.now() - started) / 60000).toFixed(1);
      const rate = done / Math.max((Date.now() - started) / 1000, 1);
      const etaMin = ((queue.length - done) / Math.max(rate, 0.01) / 60).toFixed(1);
      log(
        `progress ${done}/${queue.length} written=${written} errors=${errors} mins=${mins} ~${rate.toFixed(1)}/s eta=${etaMin}m`
      );
    }
  }
}

await Promise.all(Array.from({ length: concurrency }, () => worker()));

const summary = {
  ok: errors < errorBudget,
  dry_run: false,
  fieldId,
  queued: queue.length,
  written,
  errors,
  alreadySim,
  skippedNoMatch,
  scanned,
  aborted: errors >= errorBudget,
  mins: Number(((Date.now() - started) / 60000).toFixed(2)),
  error_samples: errorSamples,
  log: logPath,
};
fs.writeFileSync(summaryPath, JSON.stringify(summary, null, 2));
log('DONE', JSON.stringify(summary));
process.exit(summary.ok ? 0 : 2);
