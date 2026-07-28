/**
 * Fill custom fields ONLY on deals created by recent orphan-aluno provision runs.
 * Targets cache rows where markPrimaryDealId ran (last_synced_at in orphan window)
 * with empty denorm CPF/RGM — typical of NOVO_CRM_ORPHAN_SKIP_FIELDS=1 creates.
 * Empty-only: skips fields already present on the live deal (GET before PUT).
 * Does NOT create deals, change stages/flags pipeline, or run full enrich/cache sync.
 */
import 'dotenv/config';
import fs from 'node:fs';

process.env.NOVO_CRM_PROVISION_ALLOW_PROD = '1';
process.env.NOVO_CRM_API_RATE_PER_SECOND =
  process.env.NOVO_CRM_API_RATE_PER_SECOND || '5';

const SINCE =
  process.env.ORPHAN_FIELDS_SINCE || '2026-07-28T13:14:00.000Z';
const PROGRESS_EVERY_MS = Math.max(
  15000,
  Number(process.env.ORPHAN_FIELDS_PROGRESS_MS) || 30000
);
const DELAY_MS = Math.max(0, Number(process.env.ORPHAN_FIELDS_DELAY_MS) || 0);
const MAX = Math.min(
  Math.max(Number(process.env.ORPHAN_FIELDS_MAX) || 50000, 1),
  50000
);
const SKIP_LIVE_GET = String(process.env.ORPHAN_FIELDS_SKIP_LIVE_GET || '').trim() === '1';

const logPath = `data/orphan-fields-fill-${Date.now()}.log`;
function log(...args) {
  const line = `[${new Date().toISOString()}] ${args.map(String).join(' ')}`;
  console.log(line);
  fs.appendFileSync(logPath, `${line}\n`);
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function digits(v) {
  return String(v ?? '').replace(/\D/g, '');
}

function simNao(v) {
  return v ? 'Sim' : 'Não';
}

function dealFieldPresent(deal, fieldId) {
  if (!fieldId || !deal) return false;
  const panels = deal.dealPanelFields || deal.customFields || [];
  for (const f of panels) {
    const id = String(f?.fieldId || f?.id || '').trim();
    const name = String(f?.name || '').trim();
    if (id !== fieldId && name !== fieldId) continue;
    const val = f?.value ?? f?.fieldValue ?? f?.displayValue;
    if (val != null && String(val).trim() !== '') return true;
  }
  // fallback: nested customFields on deal payload shapes
  for (const f of deal.customFields || []) {
    if (String(f?.fieldId || f?.id || '') === fieldId) {
      if (f?.value != null && String(f.value).trim() !== '') return true;
    }
  }
  return false;
}

const { query } = await import('../server/db/client.js');
const { getLatestSnapshot, forEachRowDataForSnapshot } = await import(
  '../server/repositories/baseUploadRepository.js'
);
const { extractMatriculadosMappedValues } = await import(
  '../server/utils/novoCrmFieldMapping.js'
);
const {
  normalizeCpf,
  normalizeEmail,
  normalizeRgm,
} = await import('../server/utils/novoCrmCacheNormalize.js');
const { displayRgmFromMatriculadosRow } = await import('../server/utils/rgmDisplay.js');
const { cpfDigitsFromExcelCell } = await import('../server/utils/excelNumericCell.js');
const {
  classifyMatriculado,
  getNovoCrmDealFieldIds,
  getNovoCrmStageIds,
  titleCasePolo,
} = await import('../server/utils/novoCrmStageRules.js');
const { isNovoCrmWriteAllowedOnThisHost } = await import(
  '../server/services/novoCrmMatriculadosProvisionService.js'
);
const { updateDealCustomFields, getDeal } = await import(
  '../server/services/novoCrmClient.js'
);

function buildDealValues(fieldIds, mapped, row, classification) {
  return [
    digits(mapped.cpf) ? { fieldId: fieldIds.cpf, value: digits(mapped.cpf), name: 'cpf' } : null,
    digits(mapped.rgm) ? { fieldId: fieldIds.rgm, value: digits(mapped.rgm), name: 'rgm' } : null,
    mapped.curso ? { fieldId: fieldIds.curso, value: mapped.curso, name: 'curso' } : null,
    mapped.polo
      ? {
          fieldId: fieldIds.polo,
          value: titleCasePolo(mapped.polo) || mapped.polo,
          name: 'polo',
        }
      : null,
    mapped.situacao || row['Situação Matrícula']
      ? {
          fieldId: fieldIds.situacao,
          value: mapped.situacao || String(row['Situação Matrícula']),
          name: 'situacao',
        }
      : null,
    mapped.nivel && fieldIds.nivel
      ? { fieldId: fieldIds.nivel, value: mapped.nivel, name: 'nivel' }
      : null,
    mapped._email && fieldIds.email
      ? { fieldId: fieldIds.email, value: mapped._email, name: 'email' }
      : null,
    mapped.e_mail_ad && fieldIds.email_ad
      ? { fieldId: fieldIds.email_ad, value: mapped.e_mail_ad, name: 'email_ad' }
      : null,
    row['Data Nascimento'] && fieldIds.nasc
      ? {
          fieldId: fieldIds.nasc,
          value: String(row['Data Nascimento']).slice(0, 10),
          name: 'nasc',
        }
      : null,
    fieldIds.doc_pendentes
      ? {
          fieldId: fieldIds.doc_pendentes,
          value: simNao(classification.flags.doc_pendentes),
          name: 'doc_pendentes',
        }
      : null,
    fieldIds.inadimplente
      ? {
          fieldId: fieldIds.inadimplente,
          value: simNao(classification.flags.inadimplente),
          name: 'inadimplente',
        }
      : null,
    fieldIds.acessoblack
      ? {
          fieldId: fieldIds.acessoblack,
          value: simNao(classification.flags.acessoblack),
          name: 'acessoblack',
        }
      : null,
    fieldIds.evasao
      ? {
          fieldId: fieldIds.evasao,
          value: simNao(classification.flags.evasao),
          name: 'evasao',
        }
      : null,
  ].filter((v) => v && v.fieldId);
}

async function loadIdSetFromBase(category) {
  const set = new Set();
  const snap = await getLatestSnapshot(category);
  if (!snap?.id) return set;
  await forEachRowDataForSnapshot(category, snap.id, (row) => {
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

async function buildAlunoByEmailIndex(snapshotId) {
  /** @type {Map<string, Map<string, object>>} */
  const byEmail = new Map();
  const addRow = (email, item) => {
    if (!email) return;
    let group = byEmail.get(email);
    if (!group) {
      group = new Map();
      byEmail.set(email, group);
    }
    const key = item.rgm || `_norgm_${group.size}`;
    if (!group.has(key)) group.set(key, item);
  };
  await forEachRowDataForSnapshot('matriculados', snapshotId, (row) => {
    const mapped = extractMatriculadosMappedValues(row);
    const cpf = normalizeCpf(cpfDigitsFromExcelCell(mapped.cpf || row.CPF || ''));
    const rgmDisp = displayRgmFromMatriculadosRow(row);
    const rgm = normalizeRgm(rgmDisp || mapped.rgm);
    const item = { row, mapped, cpf, rgm, curso: mapped.curso };
    const email1 = normalizeEmail(mapped._email);
    const email2 = normalizeEmail(mapped.e_mail_ad);
    addRow(email1, item);
    if (email2 && email2 !== email1) addRow(email2, item);
  });
  return byEmail;
}

const stageIds = getNovoCrmStageIds();
const fieldIds = getNovoCrmDealFieldIds();

log('ORPHAN_FIELDS_FILL CRM', process.env.NOVO_CRM_API_BASE_URL);
log('writeAllowed', isNovoCrmWriteAllowedOnThisHost());
log('rate', process.env.NOVO_CRM_API_RATE_PER_SECOND);
log('since', SINCE);
log('skipLiveGet', SKIP_LIVE_GET);
log('stageIds.Graduação', stageIds['Graduação'] || stageIds.Graduação);
log(
  'fieldIds',
  JSON.stringify({
    cpf: fieldIds.cpf,
    rgm: fieldIds.rgm,
    curso: fieldIds.curso,
    polo: fieldIds.polo,
  })
);
log('logPath', logPath);

if (!isNovoCrmWriteAllowedOnThisHost()) {
  log('ABORT write gate');
  process.exit(1);
}
if (!String(stageIds['Graduação'] || '').startsWith('cmrwd5vun')) {
  log('ABORT unexpected Graduação stage id', stageIds['Graduação']);
  process.exit(1);
}
if (!fieldIds.cpf || !fieldIds.rgm || !fieldIds.curso) {
  log('ABORT missing prod field ids');
  process.exit(1);
}

log('LOAD targets from cache…');
const { rows: targets } = await query(
  `select contact_id, primary_deal_id, nome, email_norm, cpf_norm, rgm_norm,
          last_synced_at, raw_data
     from novo_crm_person_cache
    where is_deleted = false
      and primary_deal_id is not null
      and btrim(primary_deal_id) <> ''
      and last_synced_at >= $1::timestamptz
      and (
        cpf_norm is null or btrim(cpf_norm) = ''
        or rgm_norm is null or btrim(rgm_norm) = ''
      )
    order by last_synced_at asc
    limit $2`,
  [SINCE, MAX]
);
log('targets', targets.length);

const matSnap = await getLatestSnapshot('matriculados');
if (!matSnap?.id) {
  log('ABORT no matriculados snapshot');
  process.exit(1);
}
log('matriculados', matSnap.id, matSnap.file_name || '');

log('INDEX matriculados by email…');
const byEmail = await buildAlunoByEmailIndex(matSnap.id);
log('index.by_email', byEmail.size);

log('LOAD satellite bases…');
const [remat, doc, inad, bb, evasao] = await Promise.all([
  loadIdSetFromBase('rematricula'),
  loadIdSetFromBase('docs-pendentes'),
  loadIdSetFromBase('inadimplentes-vencidos'),
  loadIdSetFromBase('acessos-blackboard'),
  loadIdSetFromBase('provavel-evasao'),
]);

let updated = 0;
let skippedNoMatch = 0;
let skippedNoFill = 0;
let skippedAlreadyFilled = 0;
let errors = 0;
/** @type {Array<object>} */
const errorSamples = [];
/** @type {Array<object>} */
const samples = [];

const t0 = Date.now();
let lastProgressAt = t0;

function emitProgress(i, force = false) {
  const now = Date.now();
  if (!force && now - lastProgressAt < PROGRESS_EVERY_MS) return;
  lastProgressAt = now;
  const elapsedSec = Math.max(0.001, (now - t0) / 1000);
  const done = i;
  const rate = (done / elapsedSec).toFixed(2);
  const remain = targets.length - done;
  const etaMin = remain > 0 ? (remain / Math.max(Number(rate), 0.01) / 60).toFixed(1) : '0';
  log(
    `PROGRESS done=${done}/${targets.length} updated=${updated} skipped_no_match=${skippedNoMatch} skipped_no_fill=${skippedNoFill} skipped_filled=${skippedAlreadyFilled} errors=${errors} rate_per_s=${rate} elapsed_min=${(elapsedSec / 60).toFixed(1)} eta_min=${etaMin}`
  );
}

log('APPLY start', targets.length);
for (let i = 0; i < targets.length; i += 1) {
  const row = targets[i];
  const dealId = String(row.primary_deal_id);
  const contactId = String(row.contact_id);

  const emailCandidates = [
    normalizeEmail(row.email_norm),
    normalizeEmail(row.raw_data?.contact?.email),
  ].filter(Boolean);

  let group = null;
  let matchedEmail = null;
  for (const e of emailCandidates) {
    if (byEmail.has(e)) {
      group = byEmail.get(e);
      matchedEmail = e;
      break;
    }
  }
  if (!group) {
    skippedNoMatch += 1;
    emitProgress(i + 1);
    continue;
  }

  // Prefer item whose RGM matches denorm if any; else first.
  const items = [...group.values()];
  let it = items[0];
  const wantRgm = normalizeRgm(row.rgm_norm);
  if (wantRgm) {
    const hit = items.find((x) => x.rgm === wantRgm);
    if (hit) it = hit;
  }

  const classification = classifyMatriculado(it.row, {
    inRematricula: inSet(remat, it.cpf, it.rgm),
    inDoc: inSet(doc, it.cpf, it.rgm),
    inInad: inSet(inad, it.cpf, it.rgm),
    inBb: inSet(bb, it.cpf, it.rgm),
    inEvasao: inSet(evasao, it.cpf, it.rgm),
  });

  let values = buildDealValues(fieldIds, it.mapped, it.row, classification);
  if (!values.length) {
    skippedNoFill += 1;
    emitProgress(i + 1);
    continue;
  }

  try {
    if (!SKIP_LIVE_GET) {
      let live = null;
      try {
        live = await getDeal(dealId);
      } catch (getErr) {
        // proceed with full fill if GET fails
        log('WARN getDeal', dealId, getErr?.message || getErr);
      }
      if (live) {
        const before = values.length;
        values = values.filter((v) => !dealFieldPresent(live, v.fieldId));
        if (!values.length) {
          skippedAlreadyFilled += 1;
          emitProgress(i + 1);
          continue;
        }
        if (before !== values.length && samples.length < 5) {
          samples.push({
            type: 'partial_empty_only',
            contact_id: contactId,
            deal_id: dealId,
            filling: values.map((v) => v.name),
          });
        }
      }
    }

    await updateDealCustomFields(
      dealId,
      values.map((v) => ({ fieldId: v.fieldId, value: v.value })),
      { maxRetries: 6 }
    );
    updated += 1;
    if (samples.length < 15) {
      samples.push({
        type: 'updated',
        contact_id: contactId,
        deal_id: dealId,
        email: matchedEmail,
        rgm: it.rgm,
        fields: values.map((v) => v.name),
      });
    }
    if (DELAY_MS > 0) await sleep(DELAY_MS);
  } catch (err) {
    errors += 1;
    if (errorSamples.length < 25) {
      errorSamples.push({
        contact_id: contactId,
        deal_id: dealId,
        rgm: it.rgm,
        error: err?.message || String(err),
      });
    }
  }

  emitProgress(i + 1);
}

emitProgress(targets.length, true);

const summary = {
  ok: errors === 0 || updated > 0,
  dry_run: false,
  log_path: logPath,
  since: SINCE,
  targets: targets.length,
  updated,
  skipped_no_match: skippedNoMatch,
  skipped_no_fill: skippedNoFill,
  skipped_already_filled: skippedAlreadyFilled,
  errors,
  elapsed_min: Number(((Date.now() - t0) / 60000).toFixed(2)),
  rate: process.env.NOVO_CRM_API_RATE_PER_SECOND,
  matriculados_snapshot_id: matSnap.id,
};

log('DONE', JSON.stringify(summary));
if (errorSamples.length) log('error_samples', JSON.stringify(errorSamples.slice(0, 15)));
if (samples.length) log('samples', JSON.stringify(samples.slice(0, 10)));
fs.writeFileSync(logPath.replace('.log', '-summary.json'), JSON.stringify({ ...summary, samples, error_samples: errorSamples }, null, 2));
log('ALL DONE', logPath);
process.exit(errors > 0 && updated === 0 ? 1 : 0);
