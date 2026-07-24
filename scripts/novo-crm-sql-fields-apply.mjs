/**
 * APPLY SQL: atualiza custom fields + flags + etapas residuais no db_crm.
 * Uso:
 *   CRM_PG_PASSWORD=... node --env-file=.env scripts/novo-crm-sql-fields-apply.mjs --dry
 *   CRM_PG_PASSWORD=... node --env-file=.env scripts/novo-crm-sql-fields-apply.mjs --apply
 */
import pg from 'pg';
import { randomBytes } from 'node:crypto';
import * as baseUploadRepo from '../server/repositories/baseUploadRepository.js';
import { extractMatriculadosMappedValues } from '../server/utils/novoCrmFieldMapping.js';
import { classifyMatriculado, titleCasePolo } from '../server/utils/novoCrmStageRules.js';
import { applyNovoCrmProdIdsFromFile } from './_applyNovoCrmProdIds.mjs';

const apply = process.argv.includes('--apply');
const dry = !apply;
const ids = applyNovoCrmProdIdsFromFile();
const F = ids.fields;
const S = ids.stages;
for (const [k, v] of Object.entries(S)) {
  if (v) process.env[k] = v;
}

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
function cuidLike() {
  // IDs do CRM são cuid-like; gera id compatível o bastante pra insert.
  return `cfm${Date.now().toString(36)}${randomBytes(8).toString('hex')}`;
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

const matSnap = await baseUploadRepo.getLatestSnapshot('matriculados');
const [remat, doc, inad, bb, evasao] = await Promise.all([
  loadSet('rematricula'),
  loadSet('docs-pendentes'),
  loadSet('inadimplentes-vencidos'),
  loadSet('acessos-blackboard'),
  loadSet('provavel-evasao'),
]);

const byCpf = new Map();
const byRgm = new Map();
await baseUploadRepo.forEachRowDataForSnapshot('matriculados', matSnap.id, (row) => {
  const m = extractMatriculadosMappedValues(row);
  const cpf = digits(m.cpf);
  const rgm = digits(m.rgm);
  if (cpf.length >= 11) keepBest(byCpf, cpf, row);
  if (rgm) keepBest(byRgm, rgm, row);
});

const crm = new pg.Client({
  host: process.env.CRM_PG_HOST || '187.127.27.39',
  port: Number(process.env.CRM_PG_PORT || 5432),
  user: process.env.CRM_PG_USER || 'postgres',
  password,
  database: process.env.CRM_PG_DATABASE || 'db_crm',
  connectionTimeoutMillis: 60000,
});
await crm.connect();

const academicStages = [
  S.NOVO_CRM_STAGE_LEAD_ENTRADA,
  S.NOVO_CRM_STAGE_ACOLHIMENTO,
  S.NOVO_CRM_STAGE_GRADUACAO,
  S.NOVO_CRM_STAGE_POS,
  S.NOVO_CRM_STAGE_SEM_REMATRICULA,
  S.NOVO_CRM_STAGE_PERDIDO,
].filter(Boolean);

const UNTOUCHABLE = new Set(
  [S.NOVO_CRM_STAGE_GANHO, S.NOVO_CRM_STAGE_RETENCAO, S.NOVO_CRM_STAGE_CANCELADO].filter(Boolean)
);

const deals = await crm.query(
  `
  SELECT d.id, d."stageId", d."organizationId",
    regexp_replace(COALESCE(cpf.v,''), '[^0-9]', '', 'g') AS cpf,
    regexp_replace(COALESCE(rgm.v,''), '[^0-9]', '', 'g') AS rgm
  FROM deals d
  LEFT JOIN LATERAL (
    SELECT value AS v FROM deal_custom_field_values
    WHERE "dealId"=d.id AND "customFieldId"=$1 LIMIT 1
  ) cpf ON true
  LEFT JOIN LATERAL (
    SELECT value AS v FROM deal_custom_field_values
    WHERE "dealId"=d.id AND "customFieldId"=$2 LIMIT 1
  ) rgm ON true
  WHERE d."stageId" = ANY($3::text[])
  `,
  [F.NOVO_CRM_FIELD_CPF, F.NOVO_CRM_FIELD_RGM, academicStages]
);

console.log(`[fields] deals=${deals.rows.length} mode=${dry ? 'DRY' : 'APPLY'}`);

/** @type {Array<{id:string, organizationId:string, dealId:string, customFieldId:string, value:string}>} */
const upserts = [];
/** @type {Array<{dealId:string, stageId:string}>} */
const stageUpdates = [];

for (const row of deals.rows) {
  const cpf = digits(row.cpf);
  const rgm = digits(row.rgm);
  const matRow = (rgm && byRgm.get(rgm)) || (cpf.length >= 11 && byCpf.get(cpf)) || null;
  if (!matRow) continue;
  const mapped = extractMatriculadosMappedValues(matRow);
  const classification = classifyMatriculado(matRow, {
    inRematricula: inSet(remat, cpf, rgm),
    inDoc: inSet(doc, cpf, rgm),
    inInad: inSet(inad, cpf, rgm),
    inBb: inSet(bb, cpf, rgm),
    inEvasao: inSet(evasao, cpf, rgm),
  });

  const orgId = row.organizationId;
  const dealId = row.id;
  const pairs = [
    [F.NOVO_CRM_FIELD_CURSO, mapped.curso],
    [F.NOVO_CRM_FIELD_POLO, titleCasePolo(mapped.polo) || mapped.polo],
    [F.NOVO_CRM_FIELD_SITUACAO, mapped.situacao || String(matRow['Situação Matrícula'] || '')],
    [F.NOVO_CRM_FIELD_NIVEL, mapped.nivel],
    [F.NOVO_CRM_FIELD_EMAIL_AD, mapped.e_mail_ad],
    [F.NOVO_CRM_FIELD_DOC_PENDENTES, simNao(classification.flags.doc_pendentes)],
    [F.NOVO_CRM_FIELD_ACESSO_BLACK, simNao(classification.flags.acessoblack)],
    [F.NOVO_CRM_FIELD_EVASAO, simNao(classification.flags.evasao)],
  ];
  for (const [fieldId, value] of pairs) {
    if (!fieldId || value == null || String(value).trim() === '') continue;
    upserts.push({
      id: cuidLike(),
      organizationId: orgId,
      dealId,
      customFieldId: fieldId,
      value: String(value).trim(),
    });
  }

  if (
    classification.stageId &&
    classification.stageId !== row.stageId &&
    !UNTOUCHABLE.has(row.stageId)
  ) {
    stageUpdates.push({ dealId, stageId: classification.stageId });
  }
}

console.log(`[fields] upserts=${upserts.length} stageMoves=${stageUpdates.length}`);

if (dry) {
  console.log('[fields] DRY — sem escrita');
  await crm.end();
  process.exit(0);
}

const batch = 1500;
for (let i = 0; i < upserts.length; i += batch) {
  const chunk = upserts.slice(i, i + batch);
  const idsArr = chunk.map((x) => x.id);
  const orgs = chunk.map((x) => x.organizationId);
  const dealIds = chunk.map((x) => x.dealId);
  const fieldIds = chunk.map((x) => x.customFieldId);
  const values = chunk.map((x) => x.value);
  await crm.query(
    `
    INSERT INTO deal_custom_field_values (id, "organizationId", value, "dealId", "customFieldId")
    SELECT * FROM UNNEST($1::text[], $2::text[], $3::text[], $4::text[], $5::text[])
    ON CONFLICT ("dealId", "customFieldId")
    DO UPDATE SET value = EXCLUDED.value
    `,
    [idsArr, orgs, values, dealIds, fieldIds]
  );
  console.log(`[fields] upsert ${Math.min(i + batch, upserts.length)}/${upserts.length}`);
}

if (stageUpdates.length) {
  const dealIds = stageUpdates.map((x) => x.dealId);
  const stageIds = stageUpdates.map((x) => x.stageId);
  await crm.query(
    `
    UPDATE deals d
    SET "stageId" = v.stage_id, "updatedAt" = NOW()
    FROM (SELECT UNNEST($1::text[]) AS id, UNNEST($2::text[]) AS stage_id) v
    WHERE d.id = v.id
    `,
    [dealIds, stageIds]
  );
  console.log(`[fields] stages moved=${stageUpdates.length}`);
}

console.log('[fields] APPLY ok');
await crm.end();
process.exit(0);
