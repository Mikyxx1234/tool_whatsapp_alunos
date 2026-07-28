/**
 * Restaura remat/matriculados apagados por engano no PROD + move remat em outros funis → Sem Rematrícula.
 *
 *   CRM_PG_PASSWORD=... node --env-file=.env scripts/novo-crm-restore-remat-gap.mjs --dry
 *   CRM_PG_PASSWORD=... ALLOW_PROD=1 node --env-file=.env scripts/novo-crm-restore-remat-gap.mjs --apply
 *
 * Rate default 2 rps. Não cria duplicata se RGM/CPF já tem deal.
 */
import fs from 'node:fs';
import path from 'node:path';
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
  updateDeal,
  updateDealCustomFields,
} from '../server/services/novoCrmClient.js';
import { applyNovoCrmProdIdsFromFile } from './_applyNovoCrmProdIds.mjs';

const apply = process.argv.includes('--apply');
const dry = !apply;
const maxArg = process.argv.find((a) => a.startsWith('--max='));
const maxCreates = Math.min(Math.max(Number(maxArg?.split('=')[1]) || 2000, 1), 5000);
const moveOnly = process.argv.includes('--move-only');
const createOnly = process.argv.includes('--create-only');

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
  console.error('ALLOW_PROD=1 obrigatório para --apply');
  process.exit(2);
}

const password = process.env.CRM_PG_PASSWORD;
if (!password) {
  console.error('CRM_PG_PASSWORD obrigatório');
  process.exit(2);
}

const ORG = ids.organizationId;
const SEM = ids.stages.NOVO_CRM_STAGE_SEM_REMATRICULA;
const PIPE = ids.pipeline?.id;
const UNTOUCHABLE = new Set(
  [
    ids.stages.NOVO_CRM_STAGE_GANHO,
    ids.stages.NOVO_CRM_STAGE_RETENCAO,
    ids.stages.NOVO_CRM_STAGE_CANCELADO,
  ].filter(Boolean)
);

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
function inSet(set, cpf, rgm) {
  return (cpf && set.has(`cpf:${cpf}`)) || (rgm && set.has(`rgm:${rgm}`));
}

const fieldIds = getNovoCrmDealFieldIds();
function buildValues(mapped, row, classification) {
  /** @type {Array<{fieldId:string,value:string}>} */
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
  push(fieldIds.email, mapped._email);
  push(fieldIds.email_ad, mapped.e_mail_ad);
  push(fieldIds.doc_pendentes, simNao(classification.flags.doc_pendentes));
  push(fieldIds.acessoblack, simNao(classification.flags.acessoblack));
  push(fieldIds.evasao, simNao(classification.flags.evasao));
  push(fieldIds.inadimplente, simNao(classification.flags.inadimplente));
  return values.filter((v) => v.fieldId);
}

console.log(`[restore] mode=${dry ? 'DRY' : 'APPLY'} max=${maxCreates} rate=${process.env.NOVO_CRM_API_RATE_PER_SECOND}/s`);

const crm = new pg.Client({
  host: process.env.CRM_PG_HOST || '187.127.27.39',
  port: Number(process.env.CRM_PG_PORT || 5432),
  user: process.env.CRM_PG_USER || 'postgres',
  password,
  database: process.env.CRM_PG_DATABASE || 'db_crm',
});
await crm.connect();

const beforeSem = await crm.query(`SELECT count(*)::int AS n FROM deals WHERE "stageId" = $1`, [SEM]);
console.log(`[restore] Sem Rematrícula BEFORE: ${beforeSem.rows[0].n}`);

const rgmRows = await crm.query(
  `
  SELECT DISTINCT regexp_replace(v.value, '[^0-9]', '', 'g') AS rgm,
         v."dealId", d."stageId", s."pipelineId", d."contactId", d.title
  FROM deal_custom_field_values v
  JOIN deals d ON d.id = v."dealId"
  LEFT JOIN stages s ON s.id = d."stageId"
  WHERE v."customFieldId" = $1
    AND d."organizationId" = $2
    AND length(regexp_replace(v.value, '[^0-9]', '', 'g')) >= 5
  `,
  [ids.fields.NOVO_CRM_FIELD_RGM, ORG]
);
const cpfRows = await crm.query(
  `
  SELECT DISTINCT regexp_replace(v.value, '[^0-9]', '', 'g') AS cpf, v."dealId",
         d."stageId", s."pipelineId", d."contactId", d.title
  FROM deal_custom_field_values v
  JOIN deals d ON d.id = v."dealId"
  LEFT JOIN stages s ON s.id = d."stageId"
  WHERE v."customFieldId" = $1
    AND d."organizationId" = $2
    AND length(regexp_replace(v.value, '[^0-9]', '', 'g')) >= 9
  `,
  [ids.fields.NOVO_CRM_FIELD_CPF, ORG]
);

/** @type {Map<string, Array<object>>} */
const rgmToDeals = new Map();
for (const r of rgmRows.rows) {
  if (!rgmToDeals.has(r.rgm)) rgmToDeals.set(r.rgm, []);
  rgmToDeals.get(r.rgm).push(r);
}
/** @type {Map<string, Array<object>>} */
const cpfToDeals = new Map();
for (const r of cpfRows.rows) {
  const c = cpf11(r.cpf);
  if (!c) continue;
  if (!cpfToDeals.has(c)) cpfToDeals.set(c, []);
  cpfToDeals.get(c).push({ ...r, cpf: c });
}

const rematRgms = new Set();
const rematSnap = await baseUploadRepo.getLatestSnapshot('rematricula');
await baseUploadRepo.forEachRowDataForSnapshot('rematricula', rematSnap.id, (row) => {
  const rgm = digits(row.RGM || row.rgm);
  if (rgm) rematRgms.add(rgm);
});

const matSnap = await baseUploadRepo.getLatestSnapshot('matriculados');
const matByRgm = new Map();
await baseUploadRepo.forEachRowDataForSnapshot('matriculados', matSnap.id, (row) => {
  const m = extractMatriculadosMappedValues(row);
  const rgm = digits(m.rgm);
  if (rgm && !matByRgm.has(rgm)) matByRgm.set(rgm, row);
});

const [docBase, inad, bb, evasao] = await Promise.all([
  loadSet('docs-pendentes'),
  loadSet('inadimplentes-vencidos'),
  loadSet('acessos-blackboard'),
  loadSet('provavel-evasao'),
]);

const toMove = [];
const toCreate = [];
const toAttach = []; // CPF já tem deal, RGM remat sem deal → atualizar deal existente

for (const rgm of rematRgms) {
  const deals = rgmToDeals.get(rgm) || [];
  if (deals.some((d) => d.stageId === SEM)) continue;

  if (deals.length) {
    const movable = deals.find((d) => !UNTOUCHABLE.has(d.stageId));
    if (movable) toMove.push({ rgm, deal: movable });
    continue;
  }

  const row = matByRgm.get(rgm);
  if (!row) continue;
  const mapped = extractMatriculadosMappedValues(row);
  const cpf = cpf11(mapped.cpf);
  const existingByCpf = cpf ? cpfToDeals.get(cpf) || [] : [];
  if (existingByCpf.length) {
    const movable = existingByCpf.find((d) => !UNTOUCHABLE.has(d.stageId)) || existingByCpf[0];
    toAttach.push({ rgm, cpf, row, mapped, deal: movable });
  } else {
    toCreate.push({ rgm, cpf, row, mapped });
  }
}

console.log('[restore] plan', {
  toMove: toMove.length,
  toAttach: toAttach.length,
  toCreate: toCreate.length,
  rematTotal: rematRgms.size,
});

const report = {
  beforeSem: beforeSem.rows[0].n,
  toMove: toMove.length,
  toAttach: toAttach.length,
  toCreate: toCreate.length,
  moved: 0,
  attached: 0,
  createdContacts: 0,
  createdDeals: 0,
  skippedBadName: 0,
  skippedExisting: 0,
  errors: [],
  samples: [],
};

async function classifyFor(row, cpf, rgm) {
  return classifyMatriculado(row, {
    inRematricula: true,
    inDoc: inSet(docBase, cpf, rgm),
    inInad: inSet(inad, cpf, rgm),
    inBb: inSet(bb, cpf, rgm),
    inEvasao: inSet(evasao, cpf, rgm),
  });
}

async function findContact(mapped, cpf) {
  const queries = [];
  if (cpf) queries.push(cpf);
  const phone = phoneE164Br(mapped._phone || mapped.telefone_comercial);
  if (phone) queries.push(phone);
  if (mapped._email) queries.push(String(mapped._email).trim());
  for (const q of queries) {
    try {
      const found = await searchContacts(q);
      const item = found.items?.[0];
      if (item?.id) return item;
    } catch {
      /* ignore search fail */
    }
  }
  return null;
}

// --- MOVE ---
if (!createOnly) {
  for (const item of toMove) {
    if (dry) {
      report.moved += 1;
      if (report.samples.length < 10) {
        report.samples.push({ action: 'move', rgm: item.rgm, dealId: item.deal.dealId });
      }
      continue;
    }
    try {
      await updateDeal(item.deal.dealId, { stageId: SEM });
      report.moved += 1;
      if (report.moved % 10 === 0) console.log(`[restore] moved ${report.moved}/${toMove.length}`);
    } catch (err) {
      report.errors.push({ action: 'move', rgm: item.rgm, err: err?.message || String(err) });
    }
  }
}

// --- ATTACH (fill fields + move existing CPF deal) ---
if (!moveOnly && !createOnly) {
  for (const item of toAttach) {
    const classification = await classifyFor(item.row, item.cpf, item.rgm);
    const values = buildValues(item.mapped, item.row, classification);
    if (dry) {
      report.attached += 1;
      if (report.samples.length < 15) {
        report.samples.push({
          action: 'attach',
          rgm: item.rgm,
          cpf: item.cpf,
          dealId: item.deal.dealId,
          stage: classification.stageName,
        });
      }
      continue;
    }
    try {
      if (values.length) await updateDealCustomFields(item.deal.dealId, values);
      if (item.deal.stageId !== SEM && !UNTOUCHABLE.has(item.deal.stageId)) {
        await updateDeal(item.deal.dealId, { stageId: SEM });
      }
      report.attached += 1;
      if (report.attached % 25 === 0) {
        console.log(`[restore] attached ${report.attached}/${toAttach.length}`);
      }
    } catch (err) {
      report.errors.push({ action: 'attach', rgm: item.rgm, err: err?.message || String(err) });
    }
  }
}

// --- CREATE ---
if (!moveOnly) {
  let created = 0;
  for (const item of toCreate) {
    if (created >= maxCreates) break;
    const nome = item.mapped._nome_full || item.mapped.primeiro_nome || 'Aluno SIAA';
    if (isBadStudentName(String(item.mapped._nome_full || ''), String(item.mapped.curso || ''))) {
      report.skippedBadName += 1;
      continue;
    }
    const classification = await classifyFor(item.row, item.cpf, item.rgm);
    // remat → Sem Rematrícula (classify já faz)
    const stageId = classification.stageId || SEM;
    const values = buildValues(item.mapped, item.row, classification);

    if (dry) {
      report.createdContacts += 1;
      report.createdDeals += 1;
      created += 1;
      if (report.samples.length < 20) {
        report.samples.push({
          action: 'create',
          rgm: item.rgm,
          cpf: item.cpf,
          nome,
          stage: classification.stageName,
          nivel: item.mapped.nivel,
          fields: values.length,
        });
      }
      continue;
    }

    try {
      let contact = await findContact(item.mapped, item.cpf);
      if (!contact?.id) {
        try {
          contact = await createContact({
            name: nome,
            email: item.mapped._email || null,
            phone: phoneE164Br(item.mapped._phone || item.mapped.telefone_comercial),
            source: 'SIAA',
          });
        } catch (err) {
          const msg = err?.message || String(err);
          if (/unicidade|unique|duplicate|already/i.test(msg)) {
            contact = await findContact(item.mapped, item.cpf);
            if (!contact?.id) {
              contact = await createContact({
                name: nome,
                email: null,
                phone: null,
                source: 'SIAA',
              });
            } else {
              report.skippedExisting += 1;
            }
          } else {
            throw err;
          }
        }
      } else {
        report.skippedExisting += 1;
      }
      if (!contact?.id) throw new Error('contact id ausente');
      report.createdContacts += 1;

      const deal = await createDeal({
        title: nome,
        contactId: contact.id,
        stageId,
      });
      if (values.length) await updateDealCustomFields(deal.id, values);
      report.createdDeals += 1;
      created += 1;
      if (created % 25 === 0) {
        console.log(
          `[restore] created ${created} contacts=${report.createdContacts} deals=${report.createdDeals}`
        );
      }
    } catch (err) {
      report.errors.push({
        action: 'create',
        rgm: item.rgm,
        cpf: item.cpf,
        err: err?.message || String(err),
      });
      if (report.errors.length > 80) {
        console.error('[restore] abort — muitos erros');
        break;
      }
    }
  }
}

let afterSem = beforeSem.rows[0].n;
if (!dry) {
  const r = await crm.query(`SELECT count(*)::int AS n FROM deals WHERE "stageId" = $1`, [SEM]);
  afterSem = r.rows[0].n;
}
report.afterSem = afterSem;
report.dry = dry;

const outPath = path.join(
  process.cwd(),
  'data',
  `restore-remat-gap-${dry ? 'dry' : 'apply'}-${Date.now()}.json`
);
fs.mkdirSync(path.dirname(outPath), { recursive: true });
fs.writeFileSync(outPath, JSON.stringify(report, null, 2));
console.log('[restore] done', {
  dry,
  moved: report.moved,
  attached: report.attached,
  createdContacts: report.createdContacts,
  createdDeals: report.createdDeals,
  skippedBadName: report.skippedBadName,
  skippedExisting: report.skippedExisting,
  errors: report.errors.length,
  beforeSem: report.beforeSem,
  afterSem: report.afterSem,
  report: outPath,
});
if (report.samples.length) console.log('[restore] samples', report.samples.slice(0, 8));

await crm.end();
process.exit(report.errors.length > 80 ? 1 : 0);
