/**
 * Provisionamento matriculados → Novo CRM (criar ausentes + classificar).
 * Conservador: max por run, concurrency baixa, só DEV por default.
 * PROD: NOVO_CRM_PROVISION_ALLOW_PROD=1 + URL explícita (também libera fields/flags writers).
 *
 * Env:
 *   NOVO_CRM_PROVISION_ENABLED=1
 *   NOVO_CRM_PROVISION_MAX_PER_RUN=1000
 *   NOVO_CRM_PROVISION_CONCURRENCY=2
 *   NOVO_CRM_PROVISION_HOUR_UTC=7   (04:00 BRT; após cache full ~02:00 BRT)
 *   NOVO_CRM_PROVISION_ALLOW_PROD=0
 */

import * as baseUploadRepo from '../repositories/baseUploadRepository.js';
import * as cacheRepo from '../repositories/novoCrmPersonCacheRepository.js';
import {
  classifyMatriculado,
  getNovoCrmDealFieldIds,
  phoneE164Br,
  titleCasePolo,
} from '../utils/novoCrmStageRules.js';
import { extractMatriculadosMappedValues } from '../utils/novoCrmFieldMapping.js';
import {
  createContact,
  createDeal,
  isNovoCrmApiConfigured,
  searchContacts,
  updateDealCustomFields,
} from './novoCrmClient.js';

function digits(v) {
  return String(v ?? '').replace(/\D/g, '');
}

function normName(s) {
  return String(s ?? '')
    .toUpperCase()
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .replace(/[^A-Z0-9 ]/g, ' ')
    .replace(/\b(CST|EM|DE|DA|DO|E|BACHARELADO|LICENCIATURA|TECNOLOGO|SUPERIOR)\b/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Nome inválido = vazio ou igual/contido no nome do curso (dado ruim do SIAA). */
function isBadStudentName(nome, curso) {
  const n = normName(nome);
  if (!n) return true;
  const c = normName(curso);
  if (!c) return false;
  return c.includes(n) || n === c;
}

function apiBaseHost() {
  try {
    return new URL(String(process.env.NOVO_CRM_API_BASE_URL || '').trim()).host.toLowerCase();
  } catch {
    return String(process.env.NOVO_CRM_API_BASE_URL || '')
      .trim()
      .toLowerCase();
  }
}

/**
 * Gate de escrita CRM (provision + fields sync + flags/etapa).
 * DEV hosts na allowlist; PROD só com NOVO_CRM_PROVISION_ALLOW_PROD=1 e
 * NOVO_CRM_API_BASE_URL explícita (ex. https://crm.eduit.com.br).
 */
export function isProvisionAllowedOnThisHost() {
  if (String(process.env.NOVO_CRM_PROVISION_ALLOW_PROD || '').trim() === '1') {
    // ALLOW_PROD exige URL explícita — evita cair no default antigo de produção.
    const base = String(process.env.NOVO_CRM_API_BASE_URL || '').trim();
    if (!base) return false;
    return true;
  }
  const h = apiBaseHost();
  if (!h) return false;
  // Nunca liberar crm.eduit.com.br / produção sem ALLOW_PROD explícito.
  if (h === 'crm.eduit.com.br' || h.endsWith('.crm.eduit.com.br')) return false;
  // Allowlist estrita (não substring frouxa).
  if (h === 'crm-dev-frontend.ca31ey.easypanel.host') return true;
  if (h === 'localhost' || h === '127.0.0.1') return true;
  if (h.endsWith('.localhost')) return true;
  // Outros hosts *-dev* / crm-dev.* só se env liberar explicitamente.
  if (String(process.env.NOVO_CRM_PROVISION_ALLOW_DEV_HOSTS || '').trim() === '1') {
    return h.includes('crm-dev') || h.startsWith('crm-dev.');
  }
  return false;
}

/** Alias semântico: mesma regra do provision (fields/flags também usam). */
export function isNovoCrmWriteAllowedOnThisHost() {
  return isProvisionAllowedOnThisHost();
}

function maxPerRun() {
  // Cap via env (default 1000). Teto de segurança 20000 p/ backfill fracionado.
  return Math.min(Math.max(Number(process.env.NOVO_CRM_PROVISION_MAX_PER_RUN) || 1000, 1), 20000);
}

function provisionConcurrency() {
  // Workers simultâneos no pool. Default 2 (calm PROD overnight).
  // Throughput real ainda limitado por NOVO_CRM_API_RATE_PER_SECOND.
  return Math.min(Math.max(Number(process.env.NOVO_CRM_PROVISION_CONCURRENCY) || 2, 1), 20);
}

function maxErrorsBeforeAbort() {
  return Math.min(Math.max(Number(process.env.NOVO_CRM_PROVISION_MAX_ERRORS) || 25, 5), 100);
}

function provisionHourUtc() {
  // Default 07:00 UTC = 04:00 BRT (após cache full ~02:00 BRT / ~1h).
  return Math.max(0, Math.min(23, Math.floor(Number(process.env.NOVO_CRM_PROVISION_HOUR_UTC) || 7)));
}

/**
 * @param {string} category
 * @returns {Promise<Set<string>>} cpfs + rgms
 */
async function loadIdSetFromBase(category) {
  const set = new Set();
  const snap = await baseUploadRepo.getLatestSnapshot(category);
  if (!snap?.id) return set;
  await baseUploadRepo.forEachRowDataForSnapshot(category, snap.id, (row) => {
    const cpf = digits(row.CPF || row.cpf || row.Cpf);
    const rgm = digits(row.RGM || row.rgm || row.Rgm);
    if (cpf.length >= 11) set.add(`cpf:${cpf}`);
    if (rgm) set.add(`rgm:${rgm}`);
  });
  return set;
}

function inSet(set, cpf, rgm) {
  if (cpf && set.has(`cpf:${cpf}`)) return true;
  if (rgm && set.has(`rgm:${rgm}`)) return true;
  return false;
}

/**
 * @param {{ dryRun?: boolean, maxCreates?: number, offset?: number, jobId?: string|null }} [opts]
 */
export async function runMatriculadosProvision(opts = {}) {
  const dryRun = opts.dryRun === true;
  const maxCreates = Math.min(Math.max(Number(opts.maxCreates) || maxPerRun(), 1), 20000);
  const concurrency = provisionConcurrency();
  // offset = pula as N primeiras pessoas (grupos por CPF) na ordem determinística.
  // Usado para continuar de onde a run anterior parou sem depender de dedup/cache.
  const offset = Math.max(Number(opts.offset) || 0, 0);
  const errorBudget = maxErrorsBeforeAbort();

  if (!isNovoCrmApiConfigured()) {
    const err = new Error('NOVO_CRM_ENABLED/TOKEN não configurados');
    err.status = 503;
    throw err;
  }
  if (!isProvisionAllowedOnThisHost()) {
    const err = new Error(
      `Provision bloqueado neste host (${apiBaseHost()}). Use CRM DEV ou NOVO_CRM_PROVISION_ALLOW_PROD=1.`
    );
    err.status = 403;
    throw err;
  }

  const matSnap = await baseUploadRepo.getLatestSnapshot('matriculados');
  if (!matSnap?.id) {
    const err = new Error('Snapshot de matriculados ausente');
    err.status = 400;
    throw err;
  }

  console.log(
    `[novo-crm-provision] start dry=${dryRun} max=${maxCreates} offset=${offset} conc=${concurrency} errorBudget=${errorBudget} snap=${matSnap.id} host=${apiBaseHost()}`
  );

  const [remat, doc, inad, bb, evasao] = await Promise.all([
    loadIdSetFromBase('rematricula'),
    loadIdSetFromBase('docs-pendentes'),
    loadIdSetFromBase('inadimplentes-vencidos'),
    loadIdSetFromBase('acessos-blackboard'),
    loadIdSetFromBase('provavel-evasao'),
  ]);

  // Idempotência: CPFs já no cache do CRM (sync noturno) → não recria.
  // Torna a run repetível (a busca por CPF na API não acha, pois o CPF vive
  // no deal; o cache extrai cpf_norm do deal, então é a fonte confiável).
  const useCacheDedup =
    String(process.env.NOVO_CRM_PROVISION_USE_CACHE_DEDUP || '1').trim() !== '0';
  let existingCpfs = new Set();
  if (useCacheDedup) {
    try {
      const sets = await cacheRepo.loadExistingCpfRgmSets();
      existingCpfs = sets.cpfs;
      console.log(`[novo-crm-provision] cache dedup: ${existingCpfs.size} CPFs já no cache`);
    } catch (err) {
      console.warn('[novo-crm-provision] cache dedup indisponível:', err?.message || err);
    }
  }

  const fieldIds = getNovoCrmDealFieldIds();
  let scanned = 0;
  let skippedExisting = 0;
  let skippedNoCpf = 0;
  let createdContacts = 0;
  let createdDeals = 0;
  let errors = 0;
  let aborted = false;
  let abortReason = null;
  /** @type {Array<{cpf:string,error:string}>} */
  const errorSamples = [];
  /** @type {Array<object>} */
  const createdSamples = [];

  /** @type {Record<string, unknown>[]} */
  const candidates = [];
  await baseUploadRepo.forEachRowDataForSnapshot('matriculados', matSnap.id, (row) => {
    candidates.push(row);
  });

  // Prioriza quem está ativo (EM CURSO primeiro; cancelado por último) — assim
  // o teto de pessoas pega os ativos, mas cancelados também entram (viram deals
  // em "Perdido"). Mesmo RGM em 2 status: o EM CURSO vence o dedup (rank menor).
  const rank = (row) => {
    const sit = String(row['Situação Matrícula'] || row.Situacao || '')
      .toUpperCase()
      .normalize('NFD')
      .replace(/\p{M}/gu, '');
    if (sit.includes('CURSO')) return 0;
    if (sit.includes('CANCEL')) return 2;
    return 1;
  };
  candidates.sort((a, b) => rank(a) - rank(b));
  const preFiltered = candidates;

  // Agrupa por CPF: 1 CONTATO por pessoa, 1 NEGÓCIO por RGM distinto.
  // A base repete linhas (mesmo CPF+RGM = duplicata) e traz pessoas com 2+
  // matrículas EM CURSO (RGMs distintos) → cada RGM vira um deal no mesmo contato.
  /** @type {Map<string, Record<string, unknown>[]>} */
  const groups = new Map();
  const seenRgmByCpf = new Map();
  let skippedDupRgm = 0;
  for (const row of preFiltered) {
    const m = extractMatriculadosMappedValues(row);
    const cpf = digits(m.cpf);
    if (cpf.length < 11) {
      skippedNoCpf += 1;
      continue;
    }
    const rgm = digits(m.rgm) || '(sem-rgm)';
    let seen = seenRgmByCpf.get(cpf);
    if (!seen) {
      seen = new Set();
      seenRgmByCpf.set(cpf, seen);
      groups.set(cpf, []);
    }
    if (seen.has(rgm)) {
      skippedDupRgm += 1;
      continue;
    }
    seen.add(rgm);
    groups.get(cpf).push(row);
  }

  const simNao = (v) => (v ? 'Sim' : 'Não');
  const buildValues = (mapped, row, classification) =>
    [
      { fieldId: fieldIds.cpf, value: digits(mapped.cpf) },
      digits(mapped.rgm) ? { fieldId: fieldIds.rgm, value: digits(mapped.rgm) } : null,
      mapped.curso ? { fieldId: fieldIds.curso, value: mapped.curso } : null,
      mapped.polo
        ? { fieldId: fieldIds.polo, value: titleCasePolo(mapped.polo) || mapped.polo }
        : null,
      mapped.situacao || row['Situação Matrícula']
        ? {
            fieldId: fieldIds.situacao,
            value: mapped.situacao || String(row['Situação Matrícula']),
          }
        : null,
      mapped.nivel && fieldIds.nivel
        ? { fieldId: fieldIds.nivel, value: mapped.nivel }
        : null,
      mapped._email ? { fieldId: fieldIds.email, value: mapped._email } : null,
      mapped.e_mail_ad ? { fieldId: fieldIds.email_ad, value: mapped.e_mail_ad } : null,
      row['Data Nascimento']
        ? { fieldId: fieldIds.nasc, value: String(row['Data Nascimento']).slice(0, 10) }
        : null,
      { fieldId: fieldIds.doc_pendentes, value: simNao(classification.flags.doc_pendentes) },
      { fieldId: fieldIds.inadimplente, value: simNao(classification.flags.inadimplente) },
      { fieldId: fieldIds.acessoblack, value: simNao(classification.flags.acessoblack) },
      { fieldId: fieldIds.evasao, value: simNao(classification.flags.evasao) },
    ].filter(Boolean);

  let skippedBadName = 0;
  let skippedCache = 0;

  // maxCreates = teto de PESSOAS (contatos). Deals podem exceder (2+ RGMs).
  // Ordem determinística (mesmo snapshot + sort estável); offset pula as N
  // primeiras pessoas p/ continuar de onde a run anterior parou.
  const personList = [...groups.entries()].slice(offset);

  const noteError = (sample) => {
    errors += 1;
    if (errorSamples.length < 15) errorSamples.push(sample);
    if (errors >= errorBudget && !aborted) {
      aborted = true;
      abortReason = `abort após ${errors} erros`;
      console.error(`[novo-crm-provision] ${abortReason}`);
    }
  };

  // Processa UMA pessoa (1 contato + N deals). Counters são compartilhados —
  // seguro porque JS é single-thread (sem corrida entre awaits).
  const processPerson = async ([cpf, personRows]) => {
    if (aborted) return;

    // Reserva slot ANTES de qualquer await de create — evita overshoot do maxCreates.
    if (createdContacts >= maxCreates) return;
    const reservedSlot = { claimed: false };
    const claimSlot = () => {
      if (aborted || createdContacts >= maxCreates) return false;
      createdContacts += 1;
      reservedSlot.claimed = true;
      return true;
    };

    scanned += 1;

    // Idempotência via cache: já existe no CRM → pula sem gastar API.
    if (existingCpfs.has(cpf)) {
      skippedCache += 1;
      return;
    }

    const firstMapped = extractMatriculadosMappedValues(personRows[0]);
    const nome = firstMapped._nome_full || firstMapped.primeiro_nome || 'Aluno SIAA';

    // Nome inválido: base SIAA às vezes traz o nome do curso na coluna Nome.
    if (
      isBadStudentName(
        String(firstMapped._nome_full || '').trim(),
        String(firstMapped.curso || '').trim()
      )
    ) {
      skippedBadName += 1;
      return;
    }

    const classifications = personRows.map((r) => {
      const m = extractMatriculadosMappedValues(r);
      const rgm = digits(m.rgm);
      return {
        row: r,
        mapped: m,
        rgm,
        classification: classifyMatriculado(r, {
          inRematricula: inSet(remat, cpf, rgm),
          inDoc: inSet(doc, cpf, rgm),
          inInad: inSet(inad, cpf, rgm),
          inBb: inSet(bb, cpf, rgm),
          inEvasao: inSet(evasao, cpf, rgm),
        }),
      };
    });

    if (dryRun) {
      if (!claimSlot()) return;
      createdDeals += classifications.length;
      if (createdSamples.length < 15) {
        createdSamples.push({
          dry_run: true,
          cpf,
          nome,
          deals: classifications.map((c) => ({
            rgm: c.rgm,
            stage: c.classification.stageName,
            flags: c.classification.flags,
          })),
        });
      }
      return;
    }

    // Anti-dupe best-effort: busca por CPF no CRM.
    let existing = null;
    try {
      const found = await searchContacts(cpf);
      existing = found.items?.[0] || null;
    } catch (err) {
      noteError({ cpf, error: `search: ${err?.message || err}` });
      return;
    }
    if (existing?.id) {
      skippedExisting += 1;
      return;
    }

    if (aborted || !claimSlot()) return;

    let contact;
    try {
      contact = await createContact({
        name: nome,
        email: firstMapped._email || null,
        phone: phoneE164Br(firstMapped._phone || firstMapped.telefone_comercial),
        source: 'SIAA',
      });
    } catch (err) {
      // Desfaz reserva do slot — create falhou.
      if (reservedSlot.claimed) createdContacts = Math.max(0, createdContacts - 1);
      noteError({ cpf, error: `contact: ${err?.message || err}` });
      console.warn(`[novo-crm-provision] FAIL contato cpf=${cpf}:`, err?.message || err);
      return;
    }

    const dealSummaries = [];
    for (const c of classifications) {
      if (aborted) break;
      try {
        const deal = await createDeal({
          title: nome,
          contactId: contact.id,
          stageId: c.classification.stageId,
        });
        await updateDealCustomFields(deal.id, buildValues(c.mapped, c.row, c.classification));
        createdDeals += 1;
        dealSummaries.push({
          dealId: deal.id,
          number: deal.number,
          rgm: c.rgm,
          stage: c.classification.stageName,
        });
      } catch (err) {
        noteError({ cpf, rgm: c.rgm, error: `deal: ${err?.message || err}` });
        console.warn(`[novo-crm-provision] FAIL deal cpf=${cpf} rgm=${c.rgm}:`, err?.message || err);
      }
    }

    if (createdSamples.length < 15) {
      createdSamples.push({ contactId: contact.id, cpf, nome, deals: dealSummaries });
    }
    if (createdContacts % 50 === 0 || createdContacts === 1) {
      console.log(
        `[novo-crm-provision] contatos=${createdContacts}/${maxCreates} deals=${createdDeals} last=${cpf}`
      );
    }
  };

  // Pool de workers: cada um puxa a próxima pessoa da fila até esgotar,
  // atingir o teto ou abortar. Pacing global vem do rate limiter do client.
  let nextIndex = 0;
  const worker = async () => {
    while (true) {
      if (aborted || createdContacts >= maxCreates) return;
      const idx = nextIndex++;
      if (idx >= personList.length) return;
      await processPerson(personList[idx]);
    }
  };
  await Promise.all(Array.from({ length: concurrency }, () => worker()));

  const result = {
    ok: !aborted,
    dry_run: dryRun,
    scanned,
    created_contacts: createdContacts,
    created_deals: createdDeals,
    skipped_existing: skippedExisting,
    skipped_cache: skippedCache,
    skipped_no_cpf: skippedNoCpf,
    skipped_duplicate_rgm: skippedDupRgm,
    skipped_bad_name: skippedBadName,
    errors,
    aborted,
    abort_reason: abortReason,
    max_creates: maxCreates,
    offset,
    concurrency,
    samples: createdSamples,
    error_samples: errorSamples,
    host: apiBaseHost(),
  };
  console.log('[novo-crm-provision] done', JSON.stringify({ ...result, samples: undefined }));
  return result;
}

let activePromise = null;

export function isMatriculadosProvisionRunning() {
  return activePromise != null;
}

/**
 * Roda provision sob mutex (sync ou background). Evita dois writers em paralelo.
 * @param {{ dryRun?: boolean, maxCreates?: number, offset?: number }} opts
 * @returns {Promise<object>}
 */
export async function runMatriculadosProvisionLocked(opts = {}) {
  if (activePromise) {
    const err = new Error('Provision já em andamento');
    err.status = 409;
    throw err;
  }
  activePromise = runMatriculadosProvision(opts);
  try {
    return await activePromise;
  } finally {
    activePromise = null;
  }
}

export function startMatriculadosProvisionBackground(opts = {}) {
  if (activePromise) return false;
  activePromise = runMatriculadosProvision(opts)
    .catch((err) => {
      console.error('[novo-crm-provision] background FAIL:', err?.message || err);
      return null;
    })
    .finally(() => {
      activePromise = null;
    });
  return true;
}

function msUntilHourUtc(hourUtc) {
  const now = new Date();
  const next = new Date(now);
  next.setUTCHours(hourUtc, 0, 0, 0);
  if (next <= now) next.setUTCDate(next.getUTCDate() + 1);
  return next.getTime() - now.getTime();
}

export function startMatriculadosProvisionCron() {
  if (String(process.env.NOVO_CRM_PROVISION_ENABLED || '').trim() !== '1') {
    console.log('[novo-crm-provision] cron off (NOVO_CRM_PROVISION_ENABLED≠1)');
    return;
  }
  if (!isNovoCrmApiConfigured()) {
    console.log('[novo-crm-provision] cron off — API não configurada');
    return;
  }
  if (!isProvisionAllowedOnThisHost()) {
    console.log(
      `[novo-crm-provision] cron off — escrita bloqueada neste host (${apiBaseHost()}). Use CRM DEV ou NOVO_CRM_PROVISION_ALLOW_PROD=1 + URL explícita.`
    );
    return;
  }

  const hour = provisionHourUtc();
  const delay = msUntilHourUtc(hour);
  console.log(
    `[novo-crm-provision] cron: max=${maxPerRun()} conc=${provisionConcurrency()}; próximo em ${Math.round(delay / 60000)} min (${String(hour).padStart(2, '0')}:00 UTC)`
  );

  const first = setTimeout(() => {
    startMatriculadosProvisionBackground({ dryRun: false, maxCreates: maxPerRun() });
    const daily = setInterval(() => {
      startMatriculadosProvisionBackground({ dryRun: false, maxCreates: maxPerRun() });
    }, 24 * 60 * 60 * 1000);
    if (typeof daily?.unref === 'function') daily.unref();
  }, delay);
  if (typeof first?.unref === 'function') first.unref();
}
