/**
 * Diagnóstico dos remat ainda sem deal + restore FORÇANDO create (não attach/overwrite).
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
  console.error('ALLOW_PROD=1 obrigatório');
  process.exit(2);
}

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

const ORG = ids.organizationId;
const SEM = ids.stages.NOVO_CRM_STAGE_SEM_REMATRICULA;
const fieldIds = getNovoCrmDealFieldIds();

const crm = new pg.Client({
  host: '187.127.27.39',
  port: 5432,
  user: 'postgres',
  password: process.env.CRM_PG_PASSWORD,
  database: 'db_crm',
});
await crm.connect();

const rgmRows = await crm.query(
  `
  SELECT DISTINCT regexp_replace(v.value, '[^0-9]', '', 'g') AS rgm
  FROM deal_custom_field_values v
  JOIN deals d ON d.id = v."dealId"
  WHERE v."customFieldId" = $1 AND d."organizationId" = $2
    AND length(regexp_replace(v.value, '[^0-9]', '', 'g')) >= 5
  `,
  [ids.fields.NOVO_CRM_FIELD_RGM, ORG]
);
const existingRgm = new Set(rgmRows.rows.map((r) => r.rgm));

const rematMissing = [];
const rematSnap = await baseUploadRepo.getLatestSnapshot('rematricula');
await baseUploadRepo.forEachRowDataForSnapshot('rematricula', rematSnap.id, (row) => {
  const rgm = digits(row.RGM || row.rgm);
  if (rgm && !existingRgm.has(rgm)) rematMissing.push(rgm);
});

const matByRgm = new Map();
const matSnap = await baseUploadRepo.getLatestSnapshot('matriculados');
await baseUploadRepo.forEachRowDataForSnapshot('matriculados', matSnap.id, (row) => {
  const m = extractMatriculadosMappedValues(row);
  const rgm = digits(m.rgm);
  if (rgm && !matByRgm.has(rgm)) matByRgm.set(rgm, row);
});

console.log(`[force-create] remat missing RGM=${rematMissing.length} mode=${dry ? 'DRY' : 'APPLY'}`);
console.log('[force-create] sample', rematMissing.slice(0, 10));

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
const [docBase, inad, bb, evasao] = await Promise.all([
  loadSet('docs-pendentes'),
  loadSet('inadimplentes-vencidos'),
  loadSet('acessos-blackboard'),
  loadSet('provavel-evasao'),
]);
function inSet(set, cpf, rgm) {
  return (cpf && set.has(`cpf:${cpf}`)) || (rgm && set.has(`rgm:${rgm}`));
}

function buildValues(mapped, row, classification) {
  const values = [];
  const push = (id, v) => {
    if (id && v != null && String(v).trim() !== '') values.push({ fieldId: id, value: String(v).trim() });
  };
  push(fieldIds.cpf, cpf11(mapped.cpf));
  push(fieldIds.rgm, digits(mapped.rgm));
  push(fieldIds.curso, mapped.curso);
  push(fieldIds.polo, titleCasePolo(mapped.polo) || mapped.polo);
  push(fieldIds.situacao, mapped.situacao || String(row['Situação Matrícula'] || ''));
  push(fieldIds.nivel, mapped.nivel);
  push(fieldIds.email_ad, mapped.e_mail_ad);
  push(fieldIds.doc_pendentes, simNao(classification.flags.doc_pendentes));
  push(fieldIds.acessoblack, simNao(classification.flags.acessoblack));
  push(fieldIds.evasao, simNao(classification.flags.evasao));
  push(fieldIds.inadimplente, simNao(classification.flags.inadimplente));
  return values.filter((v) => v.fieldId);
}

async function findContact(mapped, cpf) {
  for (const q of [cpf, phoneE164Br(mapped._phone || mapped.telefone_comercial), mapped._email].filter(Boolean)) {
    try {
      const found = await searchContacts(String(q).trim());
      if (found.items?.[0]?.id) return found.items[0];
    } catch {
      /* ignore */
    }
  }
  return null;
}

let created = 0;
let errors = 0;
const errSamples = [];

for (const rgm of rematMissing) {
  const row = matByRgm.get(rgm);
  if (!row) {
    errors += 1;
    errSamples.push({ rgm, err: 'not in matriculados' });
    continue;
  }
  const mapped = extractMatriculadosMappedValues(row);
  const cpf = cpf11(mapped.cpf);
  const nome = mapped._nome_full || mapped.primeiro_nome || 'Aluno SIAA';
  const classification = classifyMatriculado(row, {
    inRematricula: true,
    inDoc: inSet(docBase, cpf, rgm),
    inInad: inSet(inad, cpf, rgm),
    inBb: inSet(bb, cpf, rgm),
    inEvasao: inSet(evasao, cpf, rgm),
  });
  const values = buildValues(mapped, row, classification);

  if (dry) {
    created += 1;
    continue;
  }

  try {
    let contact = await findContact(mapped, cpf);
    if (!contact?.id) {
      try {
        contact = await createContact({
          name: nome,
          email: mapped._email || null,
          phone: phoneE164Br(mapped._phone || mapped.telefone_comercial),
          source: 'SIAA',
        });
      } catch (err) {
        const msg = err?.message || String(err);
        if (/unicidade|unique|duplicate|already/i.test(msg)) {
          contact = await findContact(mapped, cpf);
          if (!contact?.id) {
            contact = await createContact({ name: nome, email: null, phone: null, source: 'SIAA' });
          }
        } else throw err;
      }
    }
    if (!contact?.id) throw new Error('no contact');
    const deal = await createDeal({
      title: nome,
      contactId: contact.id,
      stageId: SEM,
    });
    if (values.length) await updateDealCustomFields(deal.id, values);
    created += 1;
    existingRgm.add(rgm);
    if (created % 10 === 0) console.log(`[force-create] ${created}/${rematMissing.length}`);
  } catch (err) {
    errors += 1;
    errSamples.push({ rgm, cpf, err: err?.message || String(err) });
  }
}

const sem = await crm.query(`SELECT count(*)::int AS n FROM deals WHERE "stageId" = $1`, [SEM]);
console.log('[force-create] done', {
  dry,
  missingAtStart: rematMissing.length,
  created,
  errors,
  semRemat: sem.rows[0].n,
  errSamples: errSamples.slice(0, 5),
});
await crm.end();
process.exit(errors > 20 ? 1 : 0);
