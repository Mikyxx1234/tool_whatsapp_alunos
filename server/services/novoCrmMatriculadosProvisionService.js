/**
 * Provisionamento matriculados → Novo CRM (criar ausentes + classificar).
 * Conservador: max por run, delay alto, só DEV por default.
 *
 * Env:
 *   NOVO_CRM_PROVISION_ENABLED=1
 *   NOVO_CRM_PROVISION_MAX_PER_RUN=1000
 *   NOVO_CRM_PROVISION_DELAY_MS=3000
 *   NOVO_CRM_PROVISION_HOUR_UTC=4
 *   NOVO_CRM_PROVISION_ALLOW_PROD=0
 */

import * as baseUploadRepo from '../repositories/baseUploadRepository.js';
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

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

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
  return String(process.env.NOVO_CRM_API_BASE_URL || '')
    .trim()
    .toLowerCase();
}

export function isProvisionAllowedOnThisHost() {
  if (String(process.env.NOVO_CRM_PROVISION_ALLOW_PROD || '').trim() === '1') return true;
  const h = apiBaseHost();
  // Nunca liberar crm.eduit.com.br / produção sem ALLOW_PROD explícito.
  if (h.includes('crm.eduit.com.br') || h.includes('://crm.eduit.')) return false;
  return h.includes('crm-dev') || h.includes('localhost') || h.includes('127.0.0.1');
}

function maxPerRun() {
  // Teto duro 1000 — noite sem supervisão não escala sozinha.
  return Math.min(Math.max(Number(process.env.NOVO_CRM_PROVISION_MAX_PER_RUN) || 1000, 1), 1000);
}

function delayMs() {
  return Math.max(Number(process.env.NOVO_CRM_PROVISION_DELAY_MS) || 3000, 1500);
}

function maxErrorsBeforeAbort() {
  return Math.min(Math.max(Number(process.env.NOVO_CRM_PROVISION_MAX_ERRORS) || 25, 5), 100);
}

function provisionHourUtc() {
  return Math.max(0, Math.min(23, Math.floor(Number(process.env.NOVO_CRM_PROVISION_HOUR_UTC) || 4)));
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
 * @param {{ dryRun?: boolean, maxCreates?: number, jobId?: string|null }} [opts]
 */
export async function runMatriculadosProvision(opts = {}) {
  const dryRun = opts.dryRun === true;
  const maxCreates = Math.min(Math.max(Number(opts.maxCreates) || maxPerRun(), 1), 1000);
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
    `[novo-crm-provision] start dry=${dryRun} max=${maxCreates} delay=${delayMs()}ms errorBudget=${errorBudget} snap=${matSnap.id} host=${apiBaseHost()}`
  );

  const [remat, doc, inad, bb, evasao] = await Promise.all([
    loadIdSetFromBase('rematricula'),
    loadIdSetFromBase('docs-pendentes'),
    loadIdSetFromBase('inadimplentes-vencidos'),
    loadIdSetFromBase('acessos-blackboard'),
    loadIdSetFromBase('provavel-evasao'),
  ]);

  const fieldIds = getNovoCrmDealFieldIds();
  let scanned = 0;
  let skippedExisting = 0;
  let skippedNoCpf = 0;
  let created = 0;
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

  // Prioriza quem ainda está ativo — senão os primeiros 1000 viram quase só Cancelado.
  const includeCancelados =
    String(process.env.NOVO_CRM_PROVISION_INCLUDE_CANCELADOS || '').trim() === '1';
  const rank = (row) => {
    const sit = String(row['Situação Matrícula'] || row.Situacao || '')
      .toUpperCase()
      .normalize('NFD')
      .replace(/\p{M}/gu, '');
    if (sit.includes('CURSO')) return 0;
    if (sit.includes('CANCEL')) return includeCancelados ? 2 : 99;
    return 1;
  };
  candidates.sort((a, b) => rank(a) - rank(b));
  const preFiltered = includeCancelados
    ? candidates
    : candidates.filter((row) => rank(row) < 99);

  // Dedup por CPF: a base tem múltiplas linhas por aluno (1 por curso/matrícula).
  // Após o sort (EM CURSO primeiro), mantém a 1ª ocorrência de cada CPF.
  const seenCpf = new Set();
  let skippedDup = 0;
  const filtered = [];
  for (const row of preFiltered) {
    const cpf = digits(extractMatriculadosMappedValues(row).cpf);
    if (cpf.length < 11) {
      filtered.push(row); // deixa o loop principal contabilizar como skippedNoCpf
      continue;
    }
    if (seenCpf.has(cpf)) {
      skippedDup += 1;
      continue;
    }
    seenCpf.add(cpf);
    filtered.push(row);
  }

  let skippedBadName = 0;

  for (const row of filtered) {
    if (created >= maxCreates) break;
    scanned += 1;

    const mapped = extractMatriculadosMappedValues(row);
    const cpf = digits(mapped.cpf);
    const rgm = digits(mapped.rgm);
    if (cpf.length < 11) {
      skippedNoCpf += 1;
      continue;
    }

    // Nome inválido: base SIAA às vezes traz o nome do curso na coluna Nome.
    const nomeRaw = String(mapped._nome_full || '').trim();
    const cursoRaw = String(mapped.curso || '').trim();
    if (isBadStudentName(nomeRaw, cursoRaw)) {
      skippedBadName += 1;
      continue;
    }

    const classification = classifyMatriculado(row, {
      inRematricula: inSet(remat, cpf, rgm),
      inDoc: inSet(doc, cpf, rgm),
      inInad: inSet(inad, cpf, rgm),
      inBb: inSet(bb, cpf, rgm),
      inEvasao: inSet(evasao, cpf, rgm),
    });

    // Anti-dupe: search CRM by CPF
    let existing = null;
    try {
      const found = await searchContacts(cpf);
      existing = found.items?.[0] || null;
    } catch (err) {
      errors += 1;
      if (errorSamples.length < 15) {
        errorSamples.push({ cpf, error: `search: ${err?.message || err}` });
      }
      if (errors >= errorBudget) {
        aborted = true;
        abortReason = `abort após ${errors} erros (search)`;
        console.error(`[novo-crm-provision] ${abortReason}`);
        break;
      }
      await sleep(delayMs());
      continue;
    }

    if (existing?.id) {
      skippedExisting += 1;
      if (scanned % 200 === 0) {
        console.log(
          `[novo-crm-provision] progress scanned=${scanned} created=${created} skippedExisting=${skippedExisting}`
        );
      }
      // leve pause mesmo em skip para não martelar search
      if (scanned % 20 === 0) await sleep(Math.min(delayMs(), 800));
      continue;
    }

    const nome = mapped._nome_full || mapped.primeiro_nome || 'Aluno SIAA';
    const phone = phoneE164Br(mapped._phone || mapped.telefone_comercial);
    const email = mapped._email || null;
    const simNao = (v) => (v ? 'Sim' : 'Não');

    const payloadPreview = {
      cpf,
      rgm,
      nome,
      stage: classification.stageName,
      flags: classification.flags,
    };

    if (dryRun) {
      created += 1;
      if (createdSamples.length < 15) createdSamples.push({ dry_run: true, ...payloadPreview });
      continue;
    }

    try {
      const contact = await createContact({
        name: nome,
        email,
        phone,
        source: 'SIAA',
      });
      const deal = await createDeal({
        title: nome,
        contactId: contact.id,
        stageId: classification.stageId,
      });

      const values = [
        { fieldId: fieldIds.cpf, value: cpf },
        rgm ? { fieldId: fieldIds.rgm, value: rgm } : null,
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
        email ? { fieldId: fieldIds.email, value: email } : null,
        mapped.e_mail_ad ? { fieldId: fieldIds.email_ad, value: mapped.e_mail_ad } : null,
        row['Data Nascimento']
          ? { fieldId: fieldIds.nasc, value: String(row['Data Nascimento']).slice(0, 10) }
          : null,
        { fieldId: fieldIds.doc_pendentes, value: simNao(classification.flags.doc_pendentes) },
        { fieldId: fieldIds.inadimplente, value: simNao(classification.flags.inadimplente) },
        { fieldId: fieldIds.acessoblack, value: simNao(classification.flags.acessoblack) },
        { fieldId: fieldIds.evasao, value: simNao(classification.flags.evasao) },
      ].filter(Boolean);

      await updateDealCustomFields(deal.id, values);

      created += 1;
      if (createdSamples.length < 15) {
        createdSamples.push({
          contactId: contact.id,
          dealId: deal.id,
          number: deal.number,
          ...payloadPreview,
        });
      }
      if (created % 25 === 0 || created === 1) {
        console.log(
          `[novo-crm-provision] created ${created}/${maxCreates} last=${cpf} stage=${classification.stageName}`
        );
      }
    } catch (err) {
      errors += 1;
      if (errorSamples.length < 15) {
        errorSamples.push({ cpf, error: err?.message || String(err) });
      }
      console.warn(`[novo-crm-provision] FAIL cpf=${cpf}:`, err?.message || err);
      if (errors >= errorBudget) {
        aborted = true;
        abortReason = `abort após ${errors} erros (create)`;
        console.error(`[novo-crm-provision] ${abortReason}`);
        break;
      }
    }

    await sleep(delayMs());
  }

  const result = {
    ok: !aborted,
    dry_run: dryRun,
    scanned,
    created,
    skipped_existing: skippedExisting,
    skipped_no_cpf: skippedNoCpf,
    skipped_duplicate_cpf: skippedDup,
    skipped_bad_name: skippedBadName,
    errors,
    aborted,
    abort_reason: abortReason,
    max_creates: maxCreates,
    delay_ms: delayMs(),
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
      `[novo-crm-provision] cron off — host não é DEV (${apiBaseHost()}). Defina DEV URL ou ALLOW_PROD=1.`
    );
    return;
  }

  const hour = provisionHourUtc();
  const delay = msUntilHourUtc(hour);
  console.log(
    `[novo-crm-provision] cron: max=${maxPerRun()} delay=${delayMs()}ms; próximo em ${Math.round(delay / 60000)} min (${String(hour).padStart(2, '0')}:00 UTC)`
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
