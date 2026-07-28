/**
 * Opção A: atualiza deals.stageId no Postgres do CRM (PROD) por CPF/RGM,
 * usando classifyMatriculado + snapshot de matriculados do tool.
 *
 * Regras (classifyMatriculado):
 *   1. CANCELADO → Perdido
 *   2. Em base rematrícula → Sem Rematricula
 *   3. Ciclo 2026/2 e now <= 2026-08-25 → Acolhimento (mapa extensível)
 *   4. Else Pós / Graduação
 * Não cria/apaga contatos. Não mexe em Ganho/Retenção/Cancelado.
 * Só move quem está em Lead de Entrada (default) ou --all-movable.
 *
 * Uso:
 *   node --env-file=.env scripts/novo-crm-sql-reclassify-prod.mjs --dry --all-movable
 *   ALLOW_PROD=1 node --env-file=.env scripts/novo-crm-sql-reclassify-prod.mjs --apply --all-movable
 *   node --env-file=.env scripts/novo-crm-sql-reclassify-prod.mjs --dry --max=500
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import * as baseUploadRepo from '../server/repositories/baseUploadRepository.js';
import { extractMatriculadosMappedValues } from '../server/utils/novoCrmFieldMapping.js';
import { classifyMatriculado } from '../server/utils/novoCrmStageRules.js';
import { applyNovoCrmProdIdsFromFile } from './_applyNovoCrmProdIds.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const idsPath = path.join(root, 'data', 'novo-crm-prod-ids.json');

const args = process.argv.slice(2);
const apply = args.includes('--apply');
const dry = !apply;
const allMovable = args.includes('--all-movable');
const maxArg = args.find((a) => a.startsWith('--max='));
const maxRows = maxArg ? Math.max(1, Number(maxArg.split('=')[1]) || 0) : 0;

if (!process.env.NOVO_CRM_DATABASE_URL && !process.env.CRM_PG_PASSWORD) {
  console.error('[sql-reclass] NOVO_CRM_DATABASE_URL ou CRM_PG_PASSWORD (+ host db_crm) obrigatório');
  process.exit(2);
}
if (!process.env.DATABASE_URL) {
  console.error('[sql-reclass] DATABASE_URL (tool/disparos) obrigatório pro snapshot');
  process.exit(2);
}
if (apply && process.env.ALLOW_PROD !== '1') {
  console.error('[sql-reclass] APPLY exige ALLOW_PROD=1');
  process.exit(2);
}

const ids = applyNovoCrmProdIdsFromFile(idsPath);
const STAGE = {
  lead: ids.stages.NOVO_CRM_STAGE_LEAD_ENTRADA,
  Acolhimento: ids.stages.NOVO_CRM_STAGE_ACOLHIMENTO,
  Graduação: ids.stages.NOVO_CRM_STAGE_GRADUACAO,
  Pós: ids.stages.NOVO_CRM_STAGE_POS,
  'Sem Rematricula': ids.stages.NOVO_CRM_STAGE_SEM_REMATRICULA,
  Perdido: ids.stages.NOVO_CRM_STAGE_PERDIDO,
  Retenção: ids.stages.NOVO_CRM_STAGE_RETENCAO,
  Cancelado: ids.stages.NOVO_CRM_STAGE_CANCELADO,
  Ganho: ids.stages.NOVO_CRM_STAGE_GANHO,
};
const FIELD_CPF = ids.fields.NOVO_CRM_FIELD_CPF;
const FIELD_RGM = ids.fields.NOVO_CRM_FIELD_RGM;
const ORG_CRUZEIRO =
  process.env.NOVO_CRM_ORG_ID ||
  ids.organizationId ||
  ids.orgId ||
  'cmrmbn2lh0uz2nm016beqgbwb';

for (const [k, v] of Object.entries(STAGE)) {
  if (!v && k !== 'lead') {
    console.error(`[sql-reclass] stageId ausente: ${k}`);
    process.exit(1);
  }
}
if (!FIELD_CPF || !FIELD_RGM) {
  console.error('[sql-reclass] field CPF/RGM ausente no mapa');
  process.exit(1);
}

// Inject PROD stage IDs into env so classifyMatriculado returns PROD ids
process.env.NOVO_CRM_STAGE_ACOLHIMENTO = STAGE.Acolhimento;
process.env.NOVO_CRM_STAGE_GRADUACAO = STAGE.Graduação;
process.env.NOVO_CRM_STAGE_POS = STAGE.Pós;
process.env.NOVO_CRM_STAGE_SEM_REMATRICULA = STAGE['Sem Rematricula'];
process.env.NOVO_CRM_STAGE_PERDIDO = STAGE.Perdido;
process.env.NOVO_CRM_STAGE_RETENCAO = STAGE.Retenção;
process.env.NOVO_CRM_STAGE_CANCELADO = STAGE.Cancelado;
process.env.NOVO_CRM_STAGE_GANHO = STAGE.Ganho;

const UNTOUCHABLE = new Set([STAGE.Ganho, STAGE.Retenção, STAGE.Cancelado].filter(Boolean));

function digits(v) {
  return String(v ?? '').replace(/\D/g, '');
}

function situacaoRank(row) {
  const sit = String(row['Situação Matrícula'] || row.Situacao || '')
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

console.log(
  `[sql-reclass] mode=${dry ? 'DRY' : 'APPLY'} leadOnly=${!allMovable} max=${maxRows || '∞'} org=${ORG_CRUZEIRO}`
);
console.log(`[sql-reclass] leadEntrada=${STAGE.lead}`);
console.log(`[sql-reclass] targets:`, {
  Acolhimento: STAGE.Acolhimento,
  Graduação: STAGE.Graduação,
  Pós: STAGE.Pós,
  SemRemat: STAGE['Sem Rematricula'],
  Perdido: STAGE.Perdido,
});

// --- load SIAA snapshots from tool DB ---
const matSnap = await baseUploadRepo.getLatestSnapshot('matriculados');
if (!matSnap?.id) {
  console.error('[sql-reclass] snapshot matriculados ausente');
  process.exit(1);
}
const rematSnap = await baseUploadRepo.getLatestSnapshot('rematricula');

/** @type {Map<string, Record<string, unknown>>} */
const byCpf = new Map();
/** @type {Map<string, Record<string, unknown>>} */
const byRgm = new Map();
await baseUploadRepo.forEachRowDataForSnapshot('matriculados', matSnap.id, (row) => {
  const m = extractMatriculadosMappedValues(row);
  const cpf = digits(m.cpf);
  const rgm = digits(m.rgm);
  if (cpf.length >= 11) keepBest(byCpf, cpf, row);
  if (rgm) keepBest(byRgm, rgm, row);
});

const remat = new Set();
if (rematSnap?.id) {
  await baseUploadRepo.forEachRowDataForSnapshot('rematricula', rematSnap.id, (row) => {
    const cpf = digits(row.CPF || row.cpf || row.Cpf);
    const rgm = digits(row.RGM || row.rgm || row.Rgm);
    if (cpf.length >= 11) remat.add(`cpf:${cpf}`);
    if (rgm) remat.add(`rgm:${rgm}`);
  });
}

console.log(
  `[sql-reclass] snap mat=${matSnap.id} cpf=${byCpf.size} rgm=${byRgm.size} rematKeys=${remat.size}`
);

// --- CRM deals with CPF/RGM ---
// Prefer CRM_PG_* (PROD db_crm). Só cai em NOVO_CRM_DATABASE_URL se CRM_PG não estiver setado.
const crm = process.env.CRM_PG_PASSWORD
  ? new pg.Client({
      host: process.env.CRM_PG_HOST || '187.127.27.39',
      port: Number(process.env.CRM_PG_PORT || 5432),
      user: process.env.CRM_PG_USER || 'postgres',
      password: process.env.CRM_PG_PASSWORD,
      database: process.env.CRM_PG_DATABASE || 'db_crm',
      connectionTimeoutMillis: 30000,
    })
  : new pg.Client({ connectionString: process.env.NOVO_CRM_DATABASE_URL });
await crm.connect();
const dbInfo = process.env.CRM_PG_PASSWORD
  ? `${process.env.CRM_PG_HOST || '187.127.27.39'}/${process.env.CRM_PG_DATABASE || 'db_crm'}`
  : String(process.env.NOVO_CRM_DATABASE_URL || '').replace(/:[^:@/]+@/, ':***@');
console.log(`[sql-reclass] crm db=${dbInfo}`);

// Também marca Retenção do stagesByName (ID pode divergir do mapa stages.*)
if (ids.stagesByName?.Retenção) UNTOUCHABLE.add(ids.stagesByName.Retenção);
if (ids.stagesByName?.Cancelado) UNTOUCHABLE.add(ids.stagesByName.Cancelado);
if (ids.stagesByName?.Ganho) UNTOUCHABLE.add(ids.stagesByName.Ganho);

const STAGE_LABEL = Object.fromEntries(
  Object.entries(STAGE)
    .filter(([, id]) => id)
    .map(([name, id]) => [id, name === 'lead' ? 'Lead de Entrada' : name])
);

async function countByStage() {
  const q = await crm.query(
    `
    SELECT d."stageId" AS stage_id, COUNT(*)::int AS n
    FROM deals d
    WHERE d."organizationId" = $1
      AND d."stageId" = ANY($2::text[])
    GROUP BY d."stageId"
    ORDER BY n DESC
    `,
    [ORG_CRUZEIRO, Object.values(STAGE).filter(Boolean)]
  );
  /** @type {Record<string, number>} */
  const out = {};
  for (const r of q.rows) {
    out[STAGE_LABEL[r.stage_id] || r.stage_id] = r.n;
  }
  return out;
}

const MOVABLE_STAGE_IDS = [
  STAGE.lead,
  STAGE.Acolhimento,
  STAGE.Graduação,
  STAGE.Pós,
  STAGE['Sem Rematricula'],
  STAGE.Perdido,
].filter(Boolean);

const beforeCounts = await countByStage();
console.log('[sql-reclass] BEFORE stage counts:', beforeCounts);

const dealsQ = await crm.query(
  `
  SELECT
    d.id AS deal_id,
    d."stageId" AS stage_id,
    d.title,
    regexp_replace(COALESCE(cpf.value, ''), '[^0-9]', '', 'g') AS cpf,
    regexp_replace(COALESCE(rgm.value, ''), '[^0-9]', '', 'g') AS rgm
  FROM deals d
  LEFT JOIN deal_custom_field_values cpf
    ON cpf."dealId" = d.id AND cpf."customFieldId" = $1
  LEFT JOIN deal_custom_field_values rgm
    ON rgm."dealId" = d.id AND rgm."customFieldId" = $2
  WHERE d."organizationId" = $3
    AND (
      ($4::text IS NOT NULL AND d."stageId" = $4)
      OR ($4::text IS NULL AND d."stageId" = ANY($5::text[]))
    )
  `,
  [
    FIELD_CPF,
    FIELD_RGM,
    ORG_CRUZEIRO,
    allMovable ? null : STAGE.lead,
    MOVABLE_STAGE_IDS,
  ]
);

console.log(`[sql-reclass] deals lidos: ${dealsQ.rows.length}`);

/** @type {Record<string, number>} */
const byTarget = {};
/** @type {Array<{dealId:string, from:string, to:string, stageId:string}>} */
const updates = [];
let skippedNoMatch = 0;
let skippedUntouchable = 0;
let skippedSame = 0;
let skippedNoId = 0;

for (const row of dealsQ.rows) {
  if (maxRows && updates.length >= maxRows) break;
  const dealId = row.deal_id;
  const current = String(row.stage_id || '');
  if (UNTOUCHABLE.has(current)) {
    skippedUntouchable += 1;
    continue;
  }
  const cpf = digits(row.cpf);
  const rgm = digits(row.rgm);
  const matRow = (rgm && byRgm.get(rgm)) || (cpf.length >= 11 && byCpf.get(cpf)) || null;
  if (!matRow) {
    skippedNoMatch += 1;
    continue;
  }
  const classification = classifyMatriculado(matRow, {
    inRematricula: Boolean(
      (cpf && remat.has(`cpf:${cpf}`)) || (rgm && remat.has(`rgm:${rgm}`))
    ),
    inDoc: false,
    inInad: false,
    inBb: false,
    inEvasao: false,
  });
  const targetId = classification.stageId || STAGE[classification.stageName];
  if (!targetId) {
    skippedNoId += 1;
    continue;
  }
  byTarget[classification.stageName] = (byTarget[classification.stageName] || 0) + 1;
  if (targetId === current) {
    skippedSame += 1;
    continue;
  }
  updates.push({
    dealId,
    from: current,
    to: classification.stageName,
    stageId: targetId,
  });
}

console.log('[sql-reclass] distribuição alvo (matched):', byTarget);
console.log('[sql-reclass] a atualizar:', updates.length);
console.log('[sql-reclass] skip:', {
  no_match: skippedNoMatch,
  untouchable: skippedUntouchable,
  already_ok: skippedSame,
  no_stage_id: skippedNoId,
});
console.log('[sql-reclass] amostra:', updates.slice(0, 8));

if (dry) {
  console.log('[sql-reclass] DRY — nenhuma escrita. Use --apply --all-movable + ALLOW_PROD=1 pra gravar.');
  await crm.end();
  process.exit(0);
}

const batchSize = Math.min(
  Math.max(Number(process.env.SQL_RECLASS_BATCH || 2000), 100),
  5000
);
let n = 0;
try {
  for (let i = 0; i < updates.length; i += batchSize) {
    const chunk = updates.slice(i, i + batchSize);
    const ids = chunk.map((u) => u.dealId);
    const stages = chunk.map((u) => u.stageId);
    await crm.query(
      `
      UPDATE deals d
      SET "stageId" = v.stage_id, "updatedAt" = NOW()
      FROM (
        SELECT UNNEST($1::text[]) AS id, UNNEST($2::text[]) AS stage_id
      ) v
      WHERE d.id = v.id
      `,
      [ids, stages]
    );
    n += chunk.length;
    console.log(`[sql-reclass] batch ok ${n}/${updates.length}`);
  }
  console.log(`[sql-reclass] APPLY ok — ${n} deals movidos`);
} catch (err) {
  console.error('[sql-reclass] FAIL após', n, 'updates:', err?.message || err);
  await crm.end();
  process.exit(1);
}

const afterCounts = await countByStage();
console.log('[sql-reclass] AFTER stage counts:', afterCounts);
console.log('[sql-reclass] BEFORE→AFTER delta:');
const keys = new Set([...Object.keys(beforeCounts), ...Object.keys(afterCounts)]);
for (const k of [...keys].sort()) {
  const b = beforeCounts[k] || 0;
  const a = afterCounts[k] || 0;
  console.log(`  ${k}: ${b} → ${a} (${a - b >= 0 ? '+' : ''}${a - b})`);
}

await crm.end();
process.exit(0);
