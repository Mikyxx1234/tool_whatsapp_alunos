/**
 * Cria no CRM PROD (API) só matriculados cujo CPF ainda não está em db_crm.
 *
 *   CRM_PG_PASSWORD=... node --env-file=.env scripts/novo-crm-provision-missing-prod.mjs --dry
 *   CRM_PG_PASSWORD=... node --env-file=.env scripts/novo-crm-provision-missing-prod.mjs --apply --max=1200
 */
import pg from 'pg';
import * as baseUploadRepo from '../server/repositories/baseUploadRepository.js';
import { extractMatriculadosMappedValues } from '../server/utils/novoCrmFieldMapping.js';
import {
  classifyMatriculado,
  getNovoCrmDealFieldIds,
  phoneE164Br,
  titleCasePolo,
} from '../server/utils/novoCrmStageRules.js';
import {
  createContact,
  createDeal,
  searchContacts,
  updateDealCustomFields,
} from '../server/services/novoCrmClient.js';
import { applyNovoCrmProdIdsFromFile } from './_applyNovoCrmProdIds.mjs';

const apply = process.argv.includes('--apply');
const dry = !apply;
const maxArg = process.argv.find((a) => a.startsWith('--max='));
const maxCreates = Math.min(Math.max(Number(maxArg?.split('=')[1]) || 1200, 1), 5000);

const ids = applyNovoCrmProdIdsFromFile();
for (const [k, v] of Object.entries({ ...ids.stages, ...ids.fields })) {
  if (k.startsWith('NOVO_CRM_') && v) process.env[k] = v;
}
process.env.NOVO_CRM_FIELD_INADIMPLENTE = process.env.NOVO_CRM_FIELD_INADIMPLENTE || '-';
process.env.NOVO_CRM_PROVISION_ALLOW_PROD = '1';
process.env.NOVO_CRM_ENABLED = '1';

const password = process.env.CRM_PG_PASSWORD;
if (!password) {
  console.error('CRM_PG_PASSWORD obrigatório');
  process.exit(2);
}

function digits(v) {
  return String(v ?? '').replace(/\D/g, '');
}
function simNao(v) {
  return v ? 'Sim' : 'Não';
}
function situacaoRank(row) {
  const sit = String(row['Situação Matrícula'] || '')
    .toUpperCase()
    .normalize('NFD')
    .replace(/\p{M}/gu, '');
  if (sit.includes('CURSO')) return 0;
  if (sit.includes('CANCEL')) return 2;
  return 1;
}
function keepBest(map, key, row) {
  if (!key) return;
  const prev = map.get(key);
  if (!prev || situacaoRank(row) < situacaoRank(prev)) map.set(key, row);
}
function isBadStudentName(nome, curso) {
  const n = String(nome || '').trim().toUpperCase();
  const c = String(curso || '').trim().toUpperCase();
  if (!n || n.length < 3) return true;
  if (c && n === c) return true;
  if (/^(GRADUAC|POS|CURSO|POLO|FILTRO)/.test(n)) return true;
  return false;
}

async function loadSet(cat) {
  const set = new Set();
  const snap = await baseUploadRepo.getLatestSnapshot(cat);
  if (!snap?.id) return set;
  await baseUploadRepo.forEachRowDataForSnapshot(cat, snap.id, (row) => {
    const cpf = digits(row.CPF || row.cpf);
    const rgm = digits(row.RGM || row.rgm);
    if (cpf.length >= 11) set.add(`cpf:${cpf}`);
    if (rgm) set.add(`rgm:${rgm}`);
  });
  return set;
}
function inSet(set, cpf, rgm) {
  return (cpf && set.has(`cpf:${cpf}`)) || (rgm && set.has(`rgm:${rgm}`));
}

const fieldIds = getNovoCrmDealFieldIds();
const buildValues = (mapped, row, classification) => {
  /** @type {Array<{fieldId:string,value:string}>} */
  const values = [];
  const push = (id, v) => {
    if (id && v != null && String(v).trim() !== '') values.push({ fieldId: id, value: String(v).trim() });
  };
  push(fieldIds.cpf, digits(mapped.cpf));
  push(fieldIds.rgm, digits(mapped.rgm));
  push(fieldIds.curso, mapped.curso);
  push(fieldIds.polo, titleCasePolo(mapped.polo) || mapped.polo);
  push(fieldIds.situacao, mapped.situacao || String(row['Situação Matrícula'] || ''));
  push(fieldIds.email, mapped._email);
  push(fieldIds.email_ad, mapped.e_mail_ad);
  push(fieldIds.doc_pendentes, simNao(classification.flags.doc_pendentes));
  push(fieldIds.acessoblack, simNao(classification.flags.acessoblack));
  push(fieldIds.evasao, simNao(classification.flags.evasao));
  push(fieldIds.inadimplente, simNao(classification.flags.inadimplente));
  return values;
};

console.log(`[missing] mode=${dry ? 'DRY' : 'APPLY'} max=${maxCreates}`);

const crm = new pg.Client({
  host: process.env.CRM_PG_HOST || '187.127.27.39',
  port: Number(process.env.CRM_PG_PORT || 5432),
  user: process.env.CRM_PG_USER || 'postgres',
  password,
  database: process.env.CRM_PG_DATABASE || 'db_crm',
});
await crm.connect();
const existing = await crm.query(
  `
  SELECT DISTINCT regexp_replace(value, '[^0-9]', '', 'g') AS cpf
  FROM deal_custom_field_values
  WHERE "customFieldId" = $1 AND length(regexp_replace(value, '[^0-9]', '', 'g')) >= 11
  `,
  [ids.fields.NOVO_CRM_FIELD_CPF]
);
await crm.end();
const existingCpfs = new Set(existing.rows.map((r) => r.cpf).filter(Boolean));
console.log(`[missing] cpfs já no CRM: ${existingCpfs.size}`);

const matSnap = await baseUploadRepo.getLatestSnapshot('matriculados');
const [remat, docBase, inad, bb, evasao] = await Promise.all([
  loadSet('rematricula'),
  loadSet('docs-pendentes'),
  loadSet('inadimplentes-vencidos'),
  loadSet('acessos-blackboard'),
  loadSet('provavel-evasao'),
]);

/** @type {Map<string, Record<string, unknown>[]>} */
const byCpfRows = new Map();
await baseUploadRepo.forEachRowDataForSnapshot('matriculados', matSnap.id, (row) => {
  const m = extractMatriculadosMappedValues(row);
  const cpf = digits(m.cpf);
  if (cpf.length < 11) return;
  if (!byCpfRows.has(cpf)) byCpfRows.set(cpf, []);
  byCpfRows.get(cpf).push(row);
});

const missing = [...byCpfRows.keys()].filter((cpf) => !existingCpfs.has(cpf)).sort();
console.log(`[missing] cpfs SIAA ausentes no CRM: ${missing.length}`);

let createdContacts = 0;
let createdDeals = 0;
let skippedExisting = 0;
let skippedBadName = 0;
let errors = 0;
const concurrency = Math.min(Math.max(Number(process.env.NOVO_CRM_PROVISION_CONCURRENCY) || 8, 1), 16);

async function processCpf(cpf) {
  if (createdContacts >= maxCreates) return;
  const personRows = byCpfRows.get(cpf) || [];
  /** @type {Map<string, Record<string, unknown>>} */
  const byRgm = new Map();
  for (const row of personRows) {
    const m = extractMatriculadosMappedValues(row);
    const rgm = digits(m.rgm) || `_norgm_${byRgm.size}`;
    keepBest(byRgm, rgm, row);
  }
  const rows = [...byRgm.values()];
  if (!rows.length) return;
  const firstMapped = extractMatriculadosMappedValues(rows[0]);
  const nome = firstMapped._nome_full || firstMapped.primeiro_nome || 'Aluno SIAA';
  if (isBadStudentName(String(firstMapped._nome_full || ''), String(firstMapped.curso || ''))) {
    skippedBadName += 1;
    return;
  }

  const classifications = rows.map((r) => {
    const m = extractMatriculadosMappedValues(r);
    const rgm = digits(m.rgm);
    return {
      row: r,
      mapped: m,
      rgm,
      classification: classifyMatriculado(r, {
        inRematricula: inSet(remat, cpf, rgm),
        inDoc: inSet(docBase, cpf, rgm),
        inInad: inSet(inad, cpf, rgm),
        inBb: inSet(bb, cpf, rgm),
        inEvasao: inSet(evasao, cpf, rgm),
      }),
    };
  });

  if (dry) {
    createdContacts += 1;
    createdDeals += classifications.length;
    return;
  }

  // Skip search prévio (ganho ~2x): CPF já filtrado pelo SQL no start.
  try {
    let contact;
    try {
      contact = await createContact({
        name: nome,
        email: firstMapped._email || null,
        phone: phoneE164Br(firstMapped._phone || firstMapped.telefone_comercial),
        source: 'SIAA',
      });
    } catch (err) {
      const msg = err?.message || String(err);
      if (/unicidade|unique|duplicate|already/i.test(msg)) {
        // Telefone/email já usado: tenta achar pelo CPF e segue só o deal.
        const found = await searchContacts(cpf);
        contact = found.items?.[0] || null;
        if (!contact?.id) {
          // Última tentativa: cria sem phone/email.
          contact = await createContact({
            name: nome,
            email: null,
            phone: null,
            source: 'SIAA',
          });
        } else {
          skippedExisting += 1;
        }
      } else {
        throw err;
      }
    }
    if (!contact?.id) throw new Error('contact id ausente');
    createdContacts += 1;
    for (const c of classifications) {
      const deal = await createDeal({
        title: nome,
        contactId: contact.id,
        stageId: c.classification.stageId,
      });
      const values = buildValues(c.mapped, c.row, c.classification).filter((v) => v.fieldId);
      if (values.length) await updateDealCustomFields(deal.id, values);
      createdDeals += 1;
    }
    if (createdContacts % 50 === 0) {
      console.log(
        `[missing] created contacts=${createdContacts} deals=${createdDeals} conc=${concurrency}`
      );
    }
  } catch (err) {
    errors += 1;
    console.warn('[missing] create fail', cpf, err?.message || err);
  }
}

let nextIndex = 0;
const worker = async () => {
  while (true) {
    if (createdContacts >= maxCreates) return;
    const idx = nextIndex++;
    if (idx >= missing.length) return;
    await processCpf(missing[idx]);
  }
};

if (dry) {
  for (const cpf of missing.slice(0, maxCreates)) await processCpf(cpf);
} else {
  console.log(`[missing] workers=${concurrency} rate=${process.env.NOVO_CRM_API_RATE_PER_SECOND || 4}/s`);
  await Promise.all(Array.from({ length: concurrency }, () => worker()));
}

console.log('[missing] done', {
  dry,
  createdContacts,
  createdDeals,
  skippedExisting,
  skippedBadName,
  errors,
  pending: Math.max(0, missing.length - createdContacts - skippedBadName - skippedExisting),
});
process.exit(errors > 80 ? 1 : 0);
