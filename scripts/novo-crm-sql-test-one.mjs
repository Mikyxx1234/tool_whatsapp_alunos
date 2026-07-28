/**
 * Teste pontual: classifica 1 deal em db_crm e faz UPDATE stageId.
 * Uso: node --env-file=.env scripts/novo-crm-sql-test-one.mjs
 * Env opcional: CRM_PG_PASSWORD (default só pra este host local de teste — preferir env).
 */
import pg from 'pg';
import * as baseUploadRepo from '../server/repositories/baseUploadRepository.js';
import { extractMatriculadosMappedValues } from '../server/utils/novoCrmFieldMapping.js';
import { classifyMatriculado } from '../server/utils/novoCrmStageRules.js';
import { applyNovoCrmProdIdsFromFile } from './_applyNovoCrmProdIds.mjs';

const ids = applyNovoCrmProdIdsFromFile();
const FIELD_CPF = ids.fields.NOVO_CRM_FIELD_CPF;
const FIELD_RGM = ids.fields.NOVO_CRM_FIELD_RGM;
const STAGE = ids.stages;

process.env.NOVO_CRM_STAGE_ACOLHIMENTO = STAGE.NOVO_CRM_STAGE_ACOLHIMENTO;
process.env.NOVO_CRM_STAGE_GRADUACAO = STAGE.NOVO_CRM_STAGE_GRADUACAO;
process.env.NOVO_CRM_STAGE_POS = STAGE.NOVO_CRM_STAGE_POS;
process.env.NOVO_CRM_STAGE_SEM_REMATRICULA = STAGE.NOVO_CRM_STAGE_SEM_REMATRICULA;
process.env.NOVO_CRM_STAGE_PERDIDO = STAGE.NOVO_CRM_STAGE_PERDIDO;
process.env.NOVO_CRM_STAGE_RETENCAO = STAGE.NOVO_CRM_STAGE_RETENCAO;
process.env.NOVO_CRM_STAGE_CANCELADO = STAGE.NOVO_CRM_STAGE_CANCELADO;
process.env.NOVO_CRM_STAGE_GANHO = STAGE.NOVO_CRM_STAGE_GANHO;

const password = process.env.CRM_PG_PASSWORD || process.env.NOVO_CRM_PG_PASSWORD;
if (!password) {
  console.error('Defina CRM_PG_PASSWORD');
  process.exit(2);
}

const c = new pg.Client({
  host: process.env.CRM_PG_HOST || '187.127.27.39',
  port: Number(process.env.CRM_PG_PORT || 5432),
  user: process.env.CRM_PG_USER || 'postgres',
  password,
  database: process.env.CRM_PG_DATABASE || 'db_crm',
  connectionTimeoutMillis: 15000,
});
await c.connect();

const dealNumber = Number(process.argv.find((a) => /^\d+$/.test(a)) || 70867);
const dealQ = await c.query(
  `
  SELECT d.id, d.number, d.title, d."stageId",
         regexp_replace(COALESCE(cpf.value,''), '[^0-9]', '', 'g') AS cpf,
         regexp_replace(COALESCE(rgm.value,''), '[^0-9]', '', 'g') AS rgm
  FROM deals d
  LEFT JOIN deal_custom_field_values cpf
    ON cpf."dealId" = d.id AND cpf."customFieldId" = $1
  LEFT JOIN deal_custom_field_values rgm
    ON rgm."dealId" = d.id AND rgm."customFieldId" = $2
  WHERE d.number = $3
  ORDER BY d."updatedAt" DESC
  LIMIT 5
  `,
  [FIELD_CPF, FIELD_RGM, dealNumber]
);
console.log('deals found:', dealQ.rows);
if (!dealQ.rows.length) {
  await c.end();
  process.exit(1);
}

const deal = dealQ.rows.find((r) => r.stageId === STAGE.NOVO_CRM_STAGE_LEAD_ENTRADA) || dealQ.rows[0];
const cpf = String(deal.cpf || '');
const rgm = String(deal.rgm || '');
console.log('picked', { id: deal.id, number: deal.number, title: deal.title, stageId: deal.stageId, cpf, rgm });

const matSnap = await baseUploadRepo.getLatestSnapshot('matriculados');
const rematSnap = await baseUploadRepo.getLatestSnapshot('rematricula');
let matRow = null;
await baseUploadRepo.forEachRowDataForSnapshot('matriculados', matSnap.id, (row) => {
  if (matRow) return;
  const m = extractMatriculadosMappedValues(row);
  const rc = String(m.cpf || '').replace(/\D/g, '');
  const rr = String(m.rgm || '').replace(/\D/g, '');
  if ((rgm && rr === rgm) || (cpf.length >= 11 && rc === cpf)) matRow = row;
});

if (!matRow) {
  console.error('Sem match no snapshot matriculados');
  await c.end();
  process.exit(1);
}

const remat = new Set();
if (rematSnap?.id) {
  await baseUploadRepo.forEachRowDataForSnapshot('rematricula', rematSnap.id, (row) => {
    const rc = String(row.CPF || row.cpf || '').replace(/\D/g, '');
    const rr = String(row.RGM || row.rgm || '').replace(/\D/g, '');
    if (rc.length >= 11) remat.add(`cpf:${rc}`);
    if (rr) remat.add(`rgm:${rr}`);
  });
}

const classification = classifyMatriculado(matRow, {
  inRematricula: Boolean((cpf && remat.has(`cpf:${cpf}`)) || (rgm && remat.has(`rgm:${rgm}`))),
  inDoc: false,
  inInad: false,
  inBb: false,
  inEvasao: false,
});
console.log('classification', {
  stageName: classification.stageName,
  stageId: classification.stageId,
  meta: classification.meta,
});

if (!classification.stageId) {
  console.error('stageId vazio');
  await c.end();
  process.exit(1);
}

const dry = process.argv.includes('--dry');
if (dry) {
  console.log('DRY — não escreveu');
  await c.end();
  process.exit(0);
}

const upd = await c.query(
  `UPDATE deals SET "stageId" = $1, "updatedAt" = NOW() WHERE id = $2 RETURNING id, number, title, "stageId"`,
  [classification.stageId, deal.id]
);
console.log('UPDATED', upd.rows[0]);

const check = await c.query(
  `select d.id, d.number, d.title, s.name as stage
   from deals d join stages s on s.id = d."stageId"
   where d.id = $1`,
  [deal.id]
);
console.log('VERIFY', check.rows[0]);
await c.end();
