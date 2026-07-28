/**
 * Provision PROD: 1 contato/CPF + 1 deal/RGM (mesmo RGM em ciclos distintos = 1).
 * Exclui instituições 22, 55, 139, 140.
 *
 *   CRM_PG_PASSWORD=... node --env-file=.env scripts/novo-crm-provision-by-rgm.mjs --dry
 *   CRM_PG_PASSWORD=... ALLOW_PROD=1 node --env-file=.env scripts/novo-crm-provision-by-rgm.mjs --apply --max=5000
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
const maxCreates = Math.min(Math.max(Number(maxArg?.split('=')[1]) || 5000, 1), 20000);

/** Instituições excluídas do funil Acadêmico (códigos do campo Instituição). */
const EXCLUDE_INST = new Set(['22', '55', '139', '140']);

const ids = applyNovoCrmProdIdsFromFile();
for (const [k, v] of Object.entries({ ...ids.stages, ...ids.fields })) {
  if (k.startsWith('NOVO_CRM_') && v) process.env[k] = v;
}
process.env.NOVO_CRM_FIELD_INADIMPLENTE = process.env.NOVO_CRM_FIELD_INADIMPLENTE || '-';
process.env.NOVO_CRM_FIELD_EMAIL = process.env.NOVO_CRM_FIELD_EMAIL || '-';
process.env.NOVO_CRM_FIELD_NASC = process.env.NOVO_CRM_FIELD_NASC || '-';
process.env.NOVO_CRM_PROVISION_ALLOW_PROD = '1';
process.env.NOVO_CRM_ENABLED = '1';
process.env.NOVO_CRM_API_RATE_PER_SECOND = process.env.NOVO_CRM_API_RATE_PER_SECOND || '2';

if (apply && process.env.ALLOW_PROD !== '1') {
  console.error('[by-rgm] ALLOW_PROD=1 obrigatório para --apply');
  process.exit(2);
}

const password = process.env.CRM_PG_PASSWORD;
if (!password) {
  console.error('[by-rgm] CRM_PG_PASSWORD obrigatório');
  process.exit(2);
}

const ORG = ids.organizationId;
const FIELD_CPF = ids.fields.NOVO_CRM_FIELD_CPF;
const FIELD_RGM = ids.fields.NOVO_CRM_FIELD_RGM;

function digits(v) {
  return String(v ?? '').replace(/\D/g, '');
}
function cpf11(v) {
  const d = digits(v);
  if (!d) return '';
  if (d.length > 11) return d.slice(-11);
  return d.padStart(11, '0');
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
function instCode(row) {
  const v = String(row['Instituição'] || '');
  const m = v.match(/^(\d+)/);
  return m ? m[1] : '';
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
    const cpf = cpf11(row.CPF || row.cpf);
    const rgm = digits(row.RGM || row.rgm);
    if (cpf.length === 11) set.add(`cpf:${cpf}`);
    if (rgm) set.add(`rgm:${rgm}`);
  });
  return set;
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
  push(fieldIds.nivel, mapped.nivel);
  push(fieldIds.email, mapped._email);
  push(fieldIds.email_ad, mapped.e_mail_ad);
  push(fieldIds.doc_pendentes, simNao(classification.flags.doc_pendentes));
  push(fieldIds.acessoblack, simNao(classification.flags.acessoblack));
  push(fieldIds.evasao, simNao(classification.flags.evasao));
  push(fieldIds.inadimplente, simNao(classification.flags.inadimplente));
  return values;
};

console.log(`[by-rgm] mode=${dry ? 'DRY' : 'APPLY'} max=${maxCreates} excludeInst=${[...EXCLUDE_INST].join(',')}`);

const crm = new pg.Client({
  host: process.env.CRM_PG_HOST || '187.127.27.39',
  port: Number(process.env.CRM_PG_PORT || 5432),
  user: process.env.CRM_PG_USER || 'postgres',
  password,
  database: process.env.CRM_PG_DATABASE || 'db_crm',
});
await crm.connect();

const existingRgmQ = await crm.query(
  `
  SELECT DISTINCT regexp_replace(v.value, '[^0-9]', '', 'g') AS rgm
  FROM deal_custom_field_values v
  JOIN deals d ON d.id = v."dealId"
  WHERE d."organizationId" = $1
    AND v."customFieldId" = $2
    AND length(regexp_replace(v.value, '[^0-9]', '', 'g')) > 0
  `,
  [ORG, FIELD_RGM]
);
const existingRgms = new Set(existingRgmQ.rows.map((r) => r.rgm).filter(Boolean));

const contactByCpfQ = await crm.query(
  `
  SELECT DISTINCT ON (cpf)
    regexp_replace(v.value, '[^0-9]', '', 'g') AS cpf,
    d."contactId" AS contact_id
  FROM deal_custom_field_values v
  JOIN deals d ON d.id = v."dealId"
  WHERE d."organizationId" = $1
    AND v."customFieldId" = $2
    AND d."contactId" IS NOT NULL
    AND length(regexp_replace(v.value, '[^0-9]', '', 'g')) >= 11
  ORDER BY cpf, d."updatedAt" DESC NULLS LAST
  `,
  [ORG, FIELD_CPF]
);
/** @type {Map<string, string>} */
const contactIdByCpf = new Map();
for (const r of contactByCpfQ.rows) {
  const c = cpf11(r.cpf);
  if (c.length === 11 && r.contact_id) contactIdByCpf.set(c, r.contact_id);
}

console.log(`[by-rgm] CRM rgms=${existingRgms.size} contacts_by_cpf=${contactIdByCpf.size}`);

const matSnap = await baseUploadRepo.getLatestSnapshot('matriculados');
if (!matSnap?.id) {
  console.error('[by-rgm] snapshot matriculados ausente');
  process.exit(1);
}
const [remat, doc, inad, bb, evasao] = await Promise.all([
  loadSet('rematricula'),
  loadSet('docs-pendentes'),
  loadSet('inadimplentes-vencidos'),
  loadSet('acessos-blackboard'),
  loadSet('provavel-evasao'),
]);

/** @type {Map<string, Record<string, unknown>>} */
const byRgm = new Map();
let rawIn = 0;
let rawOut = 0;
await baseUploadRepo.forEachRowDataForSnapshot('matriculados', matSnap.id, (row) => {
  if (EXCLUDE_INST.has(instCode(row))) {
    rawOut += 1;
    return;
  }
  rawIn += 1;
  const m = extractMatriculadosMappedValues(row);
  const rgm = digits(m.rgm);
  if (rgm) keepBest(byRgm, rgm, row);
});

/** @type {Array<{rgm:string,cpf:string,row:Record<string,unknown>,mapped:ReturnType<typeof extractMatriculadosMappedValues>,classification:ReturnType<typeof classifyMatriculado>}>} */
const missing = [];
const byTarget = {};
for (const [rgm, row] of byRgm) {
  if (existingRgms.has(rgm)) continue;
  const mapped = extractMatriculadosMappedValues(row);
  const cpf = cpf11(mapped.cpf);
  if (cpf.length !== 11) continue;
  if (isBadStudentName(String(mapped._nome_full || ''), String(mapped.curso || ''))) continue;
  // Remat só por RGM — cada deal na sua fase (não puxa todos os RGMs do CPF pra Sem Remat).
  const classification = classifyMatriculado(row, {
    inRematricula: remat.has(`rgm:${rgm}`),
    inDoc: doc.has(`cpf:${cpf}`) || doc.has(`rgm:${rgm}`),
    inInad: inad.has(`cpf:${cpf}`) || inad.has(`rgm:${rgm}`),
    inBb: bb.has(`cpf:${cpf}`) || bb.has(`rgm:${rgm}`),
    inEvasao: evasao.has(`cpf:${cpf}`) || evasao.has(`rgm:${rgm}`),
  });
  byTarget[classification.stageName] = (byTarget[classification.stageName] || 0) + 1;
  missing.push({ rgm, cpf, row, mapped, classification });
}

console.log(`[by-rgm] snap=${matSnap.id} linhas_in=${rawIn} excluidas=${rawOut} rgms_unicos=${byRgm.size}`);
console.log(`[by-rgm] missing_deals=${missing.length} (cap max=${maxCreates})`);
console.log('[by-rgm] alvo etapas:', byTarget);

const toCreate = missing.slice(0, maxCreates);
if (dry) {
  console.log('[by-rgm] DRY — amostra:', toCreate.slice(0, 5).map((x) => ({
    rgm: x.rgm,
    cpf: x.cpf,
    nome: x.mapped._nome_full,
    stage: x.classification.stageName,
    nivel: x.mapped.nivel,
    hasContact: contactIdByCpf.has(x.cpf),
  })));
  await crm.end();
  process.exit(0);
}

let createdContacts = 0;
let createdDeals = 0;
let reusedContacts = 0;
let errors = 0;
const errorSamples = [];

for (let i = 0; i < toCreate.length; i++) {
  const item = toCreate[i];
  const nome = item.mapped._nome_full || item.mapped.primeiro_nome || 'Aluno SIAA';
  try {
    let contactId = contactIdByCpf.get(item.cpf) || null;
    if (!contactId) {
      try {
        const found = await searchContacts(item.cpf);
        contactId = found.items?.[0]?.id || null;
      } catch {
        /* ignore search fail */
      }
    }
    if (!contactId) {
      const contact = await createContact({
        name: nome,
        email: item.mapped._email || null,
        phone: phoneE164Br(item.mapped._phone || item.mapped.telefone_comercial),
        source: 'SIAA',
      });
      contactId = contact.id;
      contactIdByCpf.set(item.cpf, contactId);
      createdContacts += 1;
    } else {
      reusedContacts += 1;
      contactIdByCpf.set(item.cpf, contactId);
    }

    const deal = await createDeal({
      title: nome,
      contactId,
      stageId: item.classification.stageId,
    });
    await updateDealCustomFields(deal.id, buildValues(item.mapped, item.row, item.classification));
    createdDeals += 1;
    existingRgms.add(item.rgm);

    if (createdDeals % 25 === 0 || createdDeals === 1) {
      console.log(
        `[by-rgm] created ${createdDeals}/${toCreate.length} contacts_new=${createdContacts} reused=${reusedContacts} errors=${errors}`
      );
    }
  } catch (err) {
    errors += 1;
    if (errorSamples.length < 12) {
      errorSamples.push({ rgm: item.rgm, cpf: item.cpf, error: err?.message || String(err) });
    }
    console.warn(`[by-rgm] FAIL rgm=${item.rgm}:`, err?.message || err);
    if (errors >= 40) {
      console.error('[by-rgm] abort — muitos erros');
      break;
    }
  }
}

console.log('[by-rgm] DONE', {
  created_contacts: createdContacts,
  created_deals: createdDeals,
  reused_contacts: reusedContacts,
  errors,
  error_samples: errorSamples,
});

await crm.end();
process.exit(errors > 0 && createdDeals === 0 ? 1 : 0);
