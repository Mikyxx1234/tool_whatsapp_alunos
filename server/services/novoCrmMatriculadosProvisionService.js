/**
 * Provisionamento matriculados → Novo CRM (criar ausentes + classificar).
 * Conservador: max por run, concurrency baixa, só DEV por default.
 * PROD: NOVO_CRM_PROVISION_ALLOW_PROD=1 + URL explícita (também libera fields/flags writers).
 *
 * Modes:
 *   new (default UI) — só CPFs do snapshot atual ausentes do cache local
 *     (e, se houver snapshot anterior, preferir delta vs anterior). Cap ~200/dia.
 *   all — backlog completo (backfill; não usar de noite).
 *
 * Cron noturno: OFF por padrão (NOVO_CRM_PROVISION_ENABLED≠1). Criação diária
 * é via botão «Criação de leads novos» no Disparador.
 *
 * Env:
 *   NOVO_CRM_PROVISION_ENABLED=0   (cron; botão manual não depende disso)
 *   NOVO_CRM_PROVISION_MAX_PER_RUN=1000
 *   NOVO_CRM_PROVISION_NEW_MAX_PER_RUN=200
 *   NOVO_CRM_PROVISION_CONCURRENCY=2
 *   NOVO_CRM_PROVISION_HOUR_UTC=7
 *   NOVO_CRM_PROVISION_ALLOW_PROD=0
 */

import { randomUUID } from 'crypto';
import * as baseUploadRepo from '../repositories/baseUploadRepository.js';
import * as caaProtocolsRepo from '../repositories/caaProtocolsRepository.js';
import * as apiSourceRepo from '../repositories/novoCrmPersonApiSourceRepository.js';
import * as cacheRepo from '../repositories/novoCrmPersonCacheRepository.js';
import {
  classifyMatriculado,
  getNovoCrmDealFieldIds,
  isCaaWithinRetencaoWindow,
  phoneE164Br,
  titleCasePolo,
} from '../utils/novoCrmStageRules.js';
import {
  extractMatriculadosMappedValues,
  resolveSituacaoCrm,
} from '../utils/novoCrmFieldMapping.js';
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

/**
 * Chave de telefone BR comparável: descarta +55 e usa DDD + 8 últimos dígitos.
 * Unifica celular com e sem o 9 (mesma canonização de `normalize_phone_br`).
 */
function phoneMatchKey(v) {
  const d = digits(v);
  if (!d) return '';
  const local = d.length > 11 && d.startsWith('55') ? d.slice(2) : d;
  if (local.length < 10) return local;
  return local.slice(0, 2) + local.slice(-8);
}

function emailMatchKey(v) {
  return String(v ?? '').trim().toLowerCase();
}

/**
 * Acha contact existente no CRM por CPF → e-mail → telefone.
 * O CPF vive no campo do deal, então `searchContacts(cpf)` quase nunca acha —
 * e-mail/telefone são os termos que a busca de contact realmente indexa.
 * Telefone fica por último (mais sujeito a colisão/normalização DDD+8).
 *
 * A busca é fuzzy: quando o termo não casa, a API devolve a primeira página de
 * contatos (20 itens não relacionados). Só reusamos um hit quando ele confere
 * com o telefone/e-mail da pessoa, ou quando a busca devolveu um único item
 * (retorno exato — o fallback fuzzy vem sempre com página cheia).
 *
 * @param {{ cpf?: string, phone?: string, email?: string }} ids
 * @returns {Promise<{ contact: object|null, matchedBy: 'cpf'|'phone'|'email'|null, rejected: number }>}
 */
async function findExistingContact({ cpf, phone, email }) {
  const phoneTerm = digits(phone);
  const wantPhone = phoneMatchKey(phone);
  const wantEmail = emailMatchKey(email);
  const isSamePerson = (item) => {
    if (wantPhone && phoneMatchKey(item?.phone) === wantPhone) return true;
    if (wantEmail && emailMatchKey(item?.email) === wantEmail) return true;
    return false;
  };

  const attempts = [
    digits(cpf) ? { by: 'cpf', term: digits(cpf) } : null,
    wantEmail ? { by: 'email', term: wantEmail } : null,
    phoneTerm ? { by: 'phone', term: phoneTerm } : null,
  ].filter(Boolean);

  let rejected = 0;
  for (const attempt of attempts) {
    const found = await searchContacts(attempt.term);
    const items = (found.items || []).filter((it) => it?.id);
    if (!items.length) continue;
    const hit = items.find(isSamePerson) || (items.length === 1 ? items[0] : null);
    if (hit) {
      return {
        contact: hit,
        matchedBy: /** @type {'cpf'|'phone'|'email'} */ (attempt.by),
        rejected,
      };
    }
    rejected += items.length;
  }
  return { contact: null, matchedBy: null, rejected };
}

/**
 * Sincroniza somente o contact encontrado ao vivo para o espelho local.
 * Não altera o CRM. É usado pela prévia/apply para fechar a defasagem entre
 * o full noturno e os leads criados durante o dia por outros cenários.
 */
async function warmExistingContactCache(contact) {
  const deals = await apiSourceRepo.listDealsForContactId(String(contact.id));
  const details = await apiSourceRepo.fetchDealDetailsByIds(
    deals.map((d) => String(d.id)).filter(Boolean),
    { concurrency: 2, delayMs: 0 }
  );
  const snapshot = apiSourceRepo.mapApiSnapshot(contact, deals, details);
  await cacheRepo.upsertSnapshot(snapshot, { syncLogId: null, fullSeenAt: null });
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

function maxNewPerRun() {
  // Cap diário de leads novos (~10–150/dia típico; teto 500).
  return Math.min(Math.max(Number(process.env.NOVO_CRM_PROVISION_NEW_MAX_PER_RUN) || 200, 1), 500);
}

function normalizeProvisionMode(raw) {
  const m = String(raw || 'new').trim().toLowerCase();
  return m === 'all' || m === 'full' || m === 'backfill' ? 'all' : 'new';
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
 * @param {{ dryRun?: boolean, maxCreates?: number, offset?: number, mode?: 'new'|'all', jobId?: string|null }} [opts]
 */
export async function runMatriculadosProvision(opts = {}) {
  const dryRun = opts.dryRun === true;
  const mode = normalizeProvisionMode(opts.mode);
  const defaultMax = mode === 'new' ? maxNewPerRun() : maxPerRun();
  const hardCap = mode === 'new' ? 500 : 20000;
  const maxCreates = Math.min(Math.max(Number(opts.maxCreates) || defaultMax, 1), hardCap);
  const concurrency = provisionConcurrency();
  // offset = pula as N primeiras pessoas (grupos por CPF) na ordem determinística.
  // Usado para continuar de onde a run anterior parou sem depender de dedup/cache.
  const offset = Math.max(Number(opts.offset) || 0, 0);
  const errorBudget = maxErrorsBeforeAbort();
  const jobId = opts.jobId || null;

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

  // mode=new: CPFs do snapshot atual ausentes do cache; se houver snapshot
  // anterior, restringe ao delta (apareceu agora e não no anterior).
  /** @type {Set<string>|null} */
  let priorSnapCpfs = null;
  let priorSnapId = null;
  if (mode === 'new') {
    const snaps = await baseUploadRepo.listSnapshots('matriculados', { limit: 2 });
    if (snaps.length >= 2 && snaps[1]?.id) {
      priorSnapId = snaps[1].id;
      priorSnapCpfs = new Set();
      await baseUploadRepo.forEachRowDataForSnapshot('matriculados', priorSnapId, (row) => {
        const cpf = digits(row.CPF || row.cpf || row.Cpf);
        if (cpf.length >= 11) priorSnapCpfs.add(cpf);
      });
    }
  }

  console.log(
    `[novo-crm-provision] start dry=${dryRun} mode=${mode} max=${maxCreates} offset=${offset} conc=${concurrency} errorBudget=${errorBudget} snap=${matSnap.id} prior=${priorSnapId || '—'} host=${apiBaseHost()}`
  );
  touchProvisionJob(jobId, {
    phase: 'loading',
    status_message: `Carregando bases (mode=${mode})…`,
  });

  const [remat, caaT0Map, doc, inad, bb, evasao] = await Promise.all([
    loadIdSetFromBase('rematricula'),
    caaProtocolsRepo.loadOpenCaaT0Map(),
    loadIdSetFromBase('docs-pendentes'),
    loadIdSetFromBase('inadimplentes-vencidos'),
    loadIdSetFromBase('acessos-blackboard'),
    loadIdSetFromBase('provavel-evasao'),
  ]);

  // Idempotência: CPF/RGM já no cache do CRM (sync noturno) → não recria.
  // Torna a run repetível (a busca por CPF na API não acha, pois o CPF vive
  // no deal; o cache extrai cpf_norm/rgm_norm do deal, então é a fonte confiável).
  // O RGM é obrigatório no dedup porque o cpf_norm do espelho pode estar
  // corrompido (valor curto no campo CPF do deal + padStart → ex. 00000000009):
  // nesses casos o CPF não casa e a pessoa passaria como nova.
  // mode=new SEMPRE usa cache dedup (é a regra de seleção).
  const useCacheDedup =
    mode === 'new' ||
    String(process.env.NOVO_CRM_PROVISION_USE_CACHE_DEDUP || '1').trim() !== '0';
  let existingCpfs = new Set();
  let existingRgms = new Set();
  if (useCacheDedup) {
    try {
      const sets = await cacheRepo.loadExistingCpfRgmSets();
      existingCpfs = sets.cpfs;
      existingRgms = sets.rgms;
      console.log(
        `[novo-crm-provision] cache dedup: ${existingCpfs.size} CPFs · ${existingRgms.size} RGMs já no cache`
      );
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
      (() => {
        const situacao = resolveSituacaoCrm(
          mapped.situacao || row['Situação Matrícula'],
          { inRematricula: Boolean(classification.meta?.inRematricula) }
        );
        return situacao ? { fieldId: fieldIds.situacao, value: situacao } : null;
      })(),
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
  let skippedCacheRgm = 0;
  let skippedNotDelta = 0;
  let updatedExisting = 0;
  let warmedCache = 0;
  let warmCacheErrors = 0;
  const matchedBy = { cpf: 0, phone: 0, email: 0 };
  let searchFuzzyRejected = 0;

  // mode=new + snapshot anterior: só quem apareceu agora (delta).
  // Cache-miss continua obrigatório (processPerson / existingCpfs).
  if (mode === 'new' && priorSnapCpfs) {
    for (const cpf of [...groups.keys()]) {
      if (priorSnapCpfs.has(cpf)) {
        groups.delete(cpf);
        skippedNotDelta += 1;
      }
    }
  }

  // maxCreates = teto de PESSOAS (contatos). Deals podem exceder (2+ RGMs).
  // Ordem determinística (mesmo snapshot + sort estável); offset pula as N
  // primeiras pessoas p/ continuar de onde a run anterior parou.
  const personList = [...groups.entries()].slice(offset);
  touchProvisionJob(jobId, {
    phase: 'provisioning',
    status_message:
      mode === 'new'
        ? `Verificando ${personList.length} candidatos ao vivo no CRM…`
        : `Provisionando (${personList.length} candidatos, mode=${mode})…`,
    total: personList.length,
  });

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
    if (existingRgms.size) {
      const rgmHit = personRows.some((r) => {
        const rgm = digits(extractMatriculadosMappedValues(r).rgm);
        return rgm && existingRgms.has(rgm);
      });
      if (rgmHit) {
        skippedCacheRgm += 1;
        return;
      }
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
          inCaaFresh: isCaaWithinRetencaoWindow(
            caaProtocolsRepo.lookupCaaT0(caaT0Map, cpf, rgm)
          ),
          inDoc: inSet(doc, cpf, rgm),
          inInad: inSet(inad, cpf, rgm),
          inBb: inSet(bb, cpf, rgm),
          inEvasao: inSet(evasao, cpf, rgm),
        }),
      };
    });

    // Verificação live direcionada: o espelho é noturno, mas outros cenários
    // criam leads durante o dia. Tanto a prévia quanto o apply consultam o CRM
    // ao vivo e sincronizam hits no espelho sem alterar o card.
    let existing = null;
    try {
      const found = await findExistingContact({
        cpf,
        phone: firstMapped._phone || firstMapped.telefone_comercial,
        email: firstMapped._email,
      });
      existing = found.contact;
      if (found.matchedBy) matchedBy[found.matchedBy] += 1;
      searchFuzzyRejected += found.rejected;
    } catch (err) {
      noteError({ cpf, error: `search: ${err?.message || err}` });
      return;
    }

    if (existing?.id) {
      updatedExisting += 1;
      skippedExisting += 1;
      try {
        await warmExistingContactCache(existing);
        warmedCache += 1;
      } catch (err) {
        warmCacheErrors += 1;
        console.warn(
          `[novo-crm-provision] warm cache contact=${existing.id} cpf=${cpf}:`,
          err?.message || err
        );
      }
      if (createdSamples.length < 15) {
        createdSamples.push({
          dry_run: dryRun,
          cpf,
          nome,
          existing_contact_id: existing.id,
          action: 'sync_only',
        });
      }
      touchProvisionJob(jobId, {
        processed: scanned,
        status_message:
          `Verificados ${scanned}/${personList.length} · ` +
          `${updatedExisting} já existem · ${createdContacts} a criar`,
      });
      return;
    }

    if (dryRun) {
      if (!claimSlot()) return;
      createdDeals += classifications.length;
      if (createdSamples.length < 15) {
        createdSamples.push({
          dry_run: true,
          cpf,
          nome,
          action: 'would_create',
          deals: classifications.map((c) => ({
            rgm: c.rgm,
            stage: c.classification.stageName,
            flags: c.classification.flags,
          })),
        });
      }
      touchProvisionJob(jobId, {
        processed: scanned,
        sent: createdContacts,
        failed: errors,
        status_message:
          `Verificados ${scanned}/${personList.length} · ` +
          `${updatedExisting} já existem · ${createdContacts} a criar`,
      });
      return;
    }

    if (aborted || !claimSlot()) return;

    let contact = null;
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
        createdDeals += 1;
        await updateDealCustomFields(deal.id, buildValues(c.mapped, c.row, c.classification));
        dealSummaries.push({
          dealId: deal.id,
          number: deal.number,
          rgm: c.rgm,
          stage: c.classification.stageName,
          reused: false,
        });
      } catch (err) {
        noteError({ cpf, rgm: c.rgm, error: `deal: ${err?.message || err}` });
        console.warn(`[novo-crm-provision] FAIL deal cpf=${cpf} rgm=${c.rgm}:`, err?.message || err);
      }
    }

    if (createdSamples.length < 15) {
      createdSamples.push({
        contactId: contact.id,
        cpf,
        nome,
        reused_contact: false,
        deals: dealSummaries,
      });
    }
    if (createdContacts % 50 === 0 || createdContacts === 1) {
      console.log(
        `[novo-crm-provision] pessoas=${createdContacts}/${maxCreates} deals=${createdDeals} updated=${updatedExisting} last=${cpf}`
      );
    }
    touchProvisionJob(jobId, {
      processed: createdContacts,
      sent: createdDeals,
      failed: errors,
      status_message: `Processados ${createdContacts}/${maxCreates} · deals ${createdDeals}`,
    });
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
    mode,
    scanned,
    processed_people: createdContacts,
    created_contacts: createdContacts,
    created_deals: createdDeals,
    updated_existing: updatedExisting,
    skipped_existing: skippedExisting,
    skipped_cache: skippedCache,
    skipped_cache_rgm: skippedCacheRgm,
    skipped_not_delta: skippedNotDelta,
    skipped_no_cpf: skippedNoCpf,
    skipped_duplicate_rgm: skippedDupRgm,
    skipped_bad_name: skippedBadName,
    matched_by_cpf: matchedBy.cpf,
    matched_by_phone: matchedBy.phone,
    matched_by_email: matchedBy.email,
    search_fuzzy_rejected: searchFuzzyRejected,
    warmed_cache: warmedCache,
    warm_cache_errors: warmCacheErrors,
    errors,
    aborted,
    abort_reason: abortReason,
    max_creates: maxCreates,
    offset,
    concurrency,
    prior_snapshot_id: priorSnapId,
    matriculados_snapshot_id: matSnap.id,
    samples: createdSamples,
    error_samples: errorSamples,
    host: apiBaseHost(),
  };
  console.log('[novo-crm-provision] done', JSON.stringify({ ...result, samples: undefined }));
  touchProvisionJob(jobId, {
    phase: 'done',
    status_message: aborted
      ? abortReason
      : `Concluído: ${result.created_contacts} novos · ${updatedExisting} já existiam · ${createdDeals} deals`,
    processed: scanned,
    sent: createdDeals,
    failed: errors,
  });
  return result;
}

/** @type {Map<string, object>} */
const provisionJobs = new Map();
let runningProvisionJobId = null;
let activePromise = null;

function touchProvisionJob(jobId, patch) {
  if (!jobId) return;
  const entry = provisionJobs.get(jobId);
  if (!entry) return;
  Object.assign(entry, patch);
}

export function isMatriculadosProvisionRunning() {
  return activePromise != null;
}

/**
 * Roda provision sob mutex (sync ou background). Evita dois writers em paralelo.
 * @param {{ dryRun?: boolean, maxCreates?: number, offset?: number, mode?: 'new'|'all' }} opts
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

/**
 * @param {{ dryRun?: boolean, maxCreates?: number, offset?: number, mode?: 'new'|'all' }} opts
 * @returns {boolean}
 * @deprecated Prefer startMatriculadosProvisionApplyBackground (retorna jobId).
 */
export function startMatriculadosProvisionBackground(opts = {}) {
  const started = startMatriculadosProvisionApplyBackground(opts);
  return started.started;
}

/**
 * Prévia ou apply em background com jobId (polling na UI).
 * @param {{ dryRun?: boolean, maxCreates?: number, offset?: number, mode?: 'new'|'all' }} opts
 */
export function startMatriculadosProvisionApplyBackground(opts = {}) {
  if (activePromise || (runningProvisionJobId && provisionJobs.get(runningProvisionJobId)?.status === 'running')) {
    return {
      started: false,
      jobId: runningProvisionJobId,
      error: 'Provision já em andamento',
    };
  }
  const jobId = randomUUID();
  const mode = normalizeProvisionMode(opts.mode);
  const dryRun = opts.dryRun === true;
  const entry = {
    jobId,
    status: 'running',
    dry_run: dryRun,
    mode,
    total: 0,
    processed: 0,
    sent: 0,
    failed: 0,
    phase: 'starting',
    status_message: dryRun ? 'Iniciando verificação ao vivo…' : 'Iniciando criação…',
    started_at: new Date().toISOString(),
    finished_at: null,
    result: null,
    error: null,
  };
  provisionJobs.set(jobId, entry);
  runningProvisionJobId = jobId;

  activePromise = runMatriculadosProvision({
    dryRun,
    maxCreates: opts.maxCreates,
    offset: opts.offset,
    mode,
    jobId,
  })
    .then((result) => {
      entry.status = 'completed';
      entry.result = result;
      entry.finished_at = new Date().toISOString();
      return result;
    })
    .catch((err) => {
      entry.status = 'failed';
      entry.error = err?.message || String(err);
      entry.finished_at = new Date().toISOString();
      console.error('[novo-crm-provision] background FAIL:', err?.message || err);
      return null;
    })
    .finally(() => {
      activePromise = null;
      if (runningProvisionJobId === jobId) runningProvisionJobId = null;
    });

  return { started: true, jobId };
}

export function getMatriculadosProvisionJob(jobId) {
  return provisionJobs.get(String(jobId || '')) || null;
}

export function getRunningMatriculadosProvisionJob() {
  if (!runningProvisionJobId) return null;
  const j = provisionJobs.get(runningProvisionJobId);
  return j?.status === 'running' ? j : null;
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

  // Cron legado = mode=all (backfill). Produto 28/07: manter OFF —
  // criação diária é manual (mode=new) no Disparador.
  const first = setTimeout(() => {
    startMatriculadosProvisionApplyBackground({
      dryRun: false,
      maxCreates: maxPerRun(),
      mode: 'all',
    });
    const daily = setInterval(() => {
      startMatriculadosProvisionApplyBackground({
        dryRun: false,
        maxCreates: maxPerRun(),
        mode: 'all',
      });
    }, 24 * 60 * 60 * 1000);
    if (typeof daily?.unref === 'function') daily.unref();
  }, delay);
  if (typeof first?.unref === 'function') first.unref();
}
