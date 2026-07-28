/**
 * Dry-run: o que a sync de campos/flags/criação faria no PROD (db_crm).
 * Não escreve nada.
 *
 *   CRM_PG_PASSWORD=... node --env-file=.env scripts/novo-crm-sql-sync-dryrun.mjs
 */
import pg from 'pg';
import * as baseUploadRepo from '../server/repositories/baseUploadRepository.js';
import { extractMatriculadosMappedValues } from '../server/utils/novoCrmFieldMapping.js';
import { classifyMatriculado, titleCasePolo } from '../server/utils/novoCrmStageRules.js';
import { applyNovoCrmProdIdsFromFile } from './_applyNovoCrmProdIds.mjs';

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

const t0 = Date.now();
console.log('[dry] carregando snapshots…');

const matSnap = await baseUploadRepo.getLatestSnapshot('matriculados');
const [remat, doc, inad, bb, evasao] = await Promise.all([
  loadSet('rematricula'),
  loadSet('docs-pendentes'),
  loadSet('inadimplentes-vencidos'),
  loadSet('acessos-blackboard'),
  loadSet('provavel-evasao'),
]);

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

const byCpf = new Map();
const byRgm = new Map();
const allMatCpfs = new Set();
await baseUploadRepo.forEachRowDataForSnapshot('matriculados', matSnap.id, (row) => {
  const m = extractMatriculadosMappedValues(row);
  const cpf = digits(m.cpf);
  const rgm = digits(m.rgm);
  if (cpf.length >= 11) {
    keepBest(byCpf, cpf, row);
    allMatCpfs.add(cpf);
  }
  if (rgm) keepBest(byRgm, rgm, row);
});

const crm = new pg.Client({
  host: process.env.CRM_PG_HOST || '187.127.27.39',
  port: Number(process.env.CRM_PG_PORT || 5432),
  user: process.env.CRM_PG_USER || 'postgres',
  password,
  database: process.env.CRM_PG_DATABASE || 'db_crm',
  connectionTimeoutMillis: 30000,
});
await crm.connect();

const academicStages = [
  S.NOVO_CRM_STAGE_LEAD_ENTRADA,
  S.NOVO_CRM_STAGE_ACOLHIMENTO,
  S.NOVO_CRM_STAGE_GRADUACAO,
  S.NOVO_CRM_STAGE_POS,
  S.NOVO_CRM_STAGE_SEM_REMATRICULA,
  S.NOVO_CRM_STAGE_PERDIDO,
  S.NOVO_CRM_STAGE_RETENCAO,
  S.NOVO_CRM_STAGE_CANCELADO,
  S.NOVO_CRM_STAGE_GANHO,
].filter(Boolean);

const deals = await crm.query(
  `
  SELECT d.id, d."stageId",
    regexp_replace(COALESCE(cpf.v,''), '[^0-9]', '', 'g') AS cpf,
    regexp_replace(COALESCE(rgm.v,''), '[^0-9]', '', 'g') AS rgm,
    curso.v AS curso, polo.v AS polo, situacao.v AS situacao,
    email_ad.v AS email_ad,
    doc.v AS doc, black.v AS black, evasao.v AS evasao
  FROM deals d
  LEFT JOIN LATERAL (SELECT value AS v FROM deal_custom_field_values
    WHERE "dealId"=d.id AND "customFieldId"=$1 LIMIT 1) cpf ON true
  LEFT JOIN LATERAL (SELECT value AS v FROM deal_custom_field_values
    WHERE "dealId"=d.id AND "customFieldId"=$2 LIMIT 1) rgm ON true
  LEFT JOIN LATERAL (SELECT value AS v FROM deal_custom_field_values
    WHERE "dealId"=d.id AND "customFieldId"=$3 LIMIT 1) curso ON true
  LEFT JOIN LATERAL (SELECT value AS v FROM deal_custom_field_values
    WHERE "dealId"=d.id AND "customFieldId"=$4 LIMIT 1) polo ON true
  LEFT JOIN LATERAL (SELECT value AS v FROM deal_custom_field_values
    WHERE "dealId"=d.id AND "customFieldId"=$5 LIMIT 1) situacao ON true
  LEFT JOIN LATERAL (SELECT value AS v FROM deal_custom_field_values
    WHERE "dealId"=d.id AND "customFieldId"=$6 LIMIT 1) email_ad ON true
  LEFT JOIN LATERAL (SELECT value AS v FROM deal_custom_field_values
    WHERE "dealId"=d.id AND "customFieldId"=$7 LIMIT 1) doc ON true
  LEFT JOIN LATERAL (SELECT value AS v FROM deal_custom_field_values
    WHERE "dealId"=d.id AND "customFieldId"=$8 LIMIT 1) black ON true
  LEFT JOIN LATERAL (SELECT value AS v FROM deal_custom_field_values
    WHERE "dealId"=d.id AND "customFieldId"=$9 LIMIT 1) evasao ON true
  WHERE d."stageId" = ANY($10::text[])
  `,
  [
    F.NOVO_CRM_FIELD_CPF,
    F.NOVO_CRM_FIELD_RGM,
    F.NOVO_CRM_FIELD_CURSO,
    F.NOVO_CRM_FIELD_POLO,
    F.NOVO_CRM_FIELD_SITUACAO,
    F.NOVO_CRM_FIELD_EMAIL_AD || null,
    F.NOVO_CRM_FIELD_DOC_PENDENTES,
    F.NOVO_CRM_FIELD_ACESSO_BLACK,
    F.NOVO_CRM_FIELD_EVASAO,
    academicStages,
  ]
);

console.log(`[dry] deals acadêmicos lidos: ${deals.rows.length}`);

const crmCpfs = new Set();
let matched = 0;
let stageWouldMove = 0;
let fieldsWouldPatch = 0;
let flagsWouldPatch = 0;
let noMatch = 0;
const stageMoves = {};
const fieldDiffSamples = [];

for (const row of deals.rows) {
  const cpf = digits(row.cpf);
  const rgm = digits(row.rgm);
  if (cpf.length >= 11) crmCpfs.add(cpf);
  const matRow = (rgm && byRgm.get(rgm)) || (cpf.length >= 11 && byCpf.get(cpf)) || null;
  if (!matRow) {
    noMatch += 1;
    continue;
  }
  matched += 1;
  const mapped = extractMatriculadosMappedValues(matRow);
  const classification = classifyMatriculado(matRow, {
    inRematricula: inSet(remat, cpf, rgm),
    inDoc: inSet(doc, cpf, rgm),
    inInad: inSet(inad, cpf, rgm),
    inBb: inSet(bb, cpf, rgm),
    inEvasao: inSet(evasao, cpf, rgm),
  });

  if (classification.stageId && classification.stageId !== row.stageId) {
    const untouchable = new Set([
      S.NOVO_CRM_STAGE_GANHO,
      S.NOVO_CRM_STAGE_RETENCAO,
      S.NOVO_CRM_STAGE_CANCELADO,
    ]);
    if (!untouchable.has(row.stageId)) {
      stageWouldMove += 1;
      stageMoves[classification.stageName] = (stageMoves[classification.stageName] || 0) + 1;
    }
  }

  const wantCurso = mapped.curso || '';
  const wantPolo = titleCasePolo(mapped.polo) || mapped.polo || '';
  const wantSit = mapped.situacao || String(matRow['Situação Matrícula'] || '');
  const wantEmailAd = mapped.e_mail_ad || '';
  let fieldDiff = false;
  if (wantCurso && String(row.curso || '') !== wantCurso) fieldDiff = true;
  if (wantPolo && String(row.polo || '') !== wantPolo) fieldDiff = true;
  if (wantSit && String(row.situacao || '') !== wantSit) fieldDiff = true;
  if (wantEmailAd && F.NOVO_CRM_FIELD_EMAIL_AD && String(row.email_ad || '') !== wantEmailAd) {
    fieldDiff = true;
  }
  if (fieldDiff) {
    fieldsWouldPatch += 1;
    if (fieldDiffSamples.length < 5) {
      fieldDiffSamples.push({
        dealId: row.id,
        cpf,
        curso: [row.curso, wantCurso],
        polo: [row.polo, wantPolo],
        situacao: [row.situacao, wantSit],
      });
    }
  }

  const wantDoc = simNao(classification.flags.doc_pendentes);
  const wantBlack = simNao(classification.flags.acessoblack);
  const wantEvasao = simNao(classification.flags.evasao);
  if (
    String(row.doc || '') !== wantDoc ||
    String(row.black || '') !== wantBlack ||
    String(row.evasao || '') !== wantEvasao
  ) {
    flagsWouldPatch += 1;
  }
}

let missingCreates = 0;
for (const cpf of allMatCpfs) {
  if (!crmCpfs.has(cpf)) missingCreates += 1;
}

await crm.end();
const ms = Date.now() - t0;

console.log('\n=== DRY-RUN PROD (sem escrita) ===');
console.log({
  elapsed_s: Math.round(ms / 1000),
  matched,
  no_match_deals: noMatch,
  stage_would_move: stageWouldMove,
  stage_moves: stageMoves,
  fields_would_patch: fieldsWouldPatch,
  flags_would_patch: flagsWouldPatch,
  provision_missing_cpfs: missingCreates,
  samples_field_diff: fieldDiffSamples,
});
console.log(
  `\nEstimativa APPLY:\n` +
    `  - SQL campos+flags (~${fieldsWouldPatch + flagsWouldPatch} patches): 1–5 min\n` +
    `  - Provision criar ~${missingCreates} ausentes via API: ~${Math.max(1, Math.ceil(missingCreates / 60))}–${Math.max(2, Math.ceil(missingCreates / 30))} min (rate limit)\n` +
    `  - Etapas restantes a mover: ${stageWouldMove}`
);
