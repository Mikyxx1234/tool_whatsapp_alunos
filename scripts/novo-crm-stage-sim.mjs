/**
 * Dry-run: quantos deals (por RGM) / pessoas (por CPF) cairiam em cada etapa
 * Novo CRM segundo classifyMatriculado + rematrícula + CAA open (sem escrita no CRM).
 *
 * Uso: node scripts/novo-crm-stage-sim.mjs
 * Saída: data/stage-sim-<ts>.json + tabela no stdout
 */
import 'dotenv/config';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as baseUploadRepo from '../server/repositories/baseUploadRepository.js';
import * as caaProtocolsRepo from '../server/repositories/caaProtocolsRepository.js';
import { extractMatriculadosMappedValues } from '../server/utils/novoCrmFieldMapping.js';
import { classifyMatriculado } from '../server/utils/novoCrmStageRules.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

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

function keepBestRow(map, key, row) {
  if (!key) return;
  const prev = map.get(key);
  if (!prev || situacaoRank(row) < situacaoRank(prev)) map.set(key, row);
}

async function loadIdSetFromBase(category) {
  const set = new Set();
  const snap = await baseUploadRepo.getLatestSnapshot(category);
  if (!snap?.id) return { set, snap: null };
  await baseUploadRepo.forEachRowDataForSnapshot(category, snap.id, (row) => {
    const cpf = digits(row.CPF || row.cpf || row.Cpf);
    const rgm = digits(row.RGM || row.rgm || row.Rgm);
    if (cpf.length >= 11) set.add(`cpf:${cpf}`);
    if (rgm) set.add(`rgm:${rgm}`);
  });
  return { set, snap };
}

function inSet(set, cpf, rgm) {
  if (cpf && set.has(`cpf:${cpf}`)) return true;
  if (rgm && set.has(`rgm:${rgm}`)) return true;
  return false;
}

function emptyCounters() {
  return {
    by_stage: {},
    breakout: {
      perdido_trancado: 0,
      perdido_cancelado: 0,
      perdido_ambos: 0,
      retencao_caa: 0,
      sem_rematricula: 0,
      acolhimento: 0,
      graduacao: 0,
      pos: 0,
      graduacao_default_nao_grad_nem_pos: 0,
    },
    rows: 0,
    skipped_no_key: 0,
  };
}

function bump(counters, cl) {
  const stage = cl.stageName;
  counters.by_stage[stage] = (counters.by_stage[stage] || 0) + 1;
  counters.rows += 1;
  const m = cl.meta || {};
  if (stage === 'Perdido') {
    if (m.isTrancado && m.isCancelado) counters.breakout.perdido_ambos += 1;
    else if (m.isTrancado) counters.breakout.perdido_trancado += 1;
    else if (m.isCancelado) counters.breakout.perdido_cancelado += 1;
  } else if (stage === 'Retenção') {
    counters.breakout.retencao_caa += 1;
  } else if (stage === 'Sem Rematricula') {
    counters.breakout.sem_rematricula += 1;
  } else if (stage === 'Acolhimento') {
    counters.breakout.acolhimento += 1;
  } else if (stage === 'Graduação') {
    counters.breakout.graduacao += 1;
    if (!m.isGrad && !m.isPos) counters.breakout.graduacao_default_nao_grad_nem_pos += 1;
  } else if (stage === 'Pós') {
    counters.breakout.pos += 1;
  }
}

function classifyRow(row, remat, caa, now) {
  const m = extractMatriculadosMappedValues(row);
  const cpf = digits(m.cpf);
  const rgm = digits(m.rgm);
  return classifyMatriculado(row, {
    inRematricula: inSet(remat, cpf, rgm),
    inCaa: inSet(caa, cpf, rgm),
    inDoc: false,
    inInad: false,
    inBb: false,
    inEvasao: false,
    now,
  });
}

async function optionalCacheStageCounts() {
  // Opcional — não bloqueia a simulação se falhar / for lento.
  if (String(process.env.STAGE_SIM_SKIP_CACHE || '').trim() === '1') return null;
  try {
    const { default: pg } = await import('pg');
    const url = process.env.DATABASE_URL || process.env.POSTGRES_URL;
    if (!url) return null;
    const pool = new pg.Pool({
      connectionString: url,
      max: 1,
      connectionTimeoutMillis: 15_000,
      statement_timeout: 60_000,
    });
    try {
      // stage fica em raw_data.dealsById[primary_deal_id].stageName (ou stageId)
      const q = await pool.query(`
        SELECT
          COALESCE(
            NULLIF(trim(deal.value->>'stageName'), ''),
            NULLIF(trim(deal.value->>'stage'), ''),
            '(sem stage)'
          ) AS stage,
          COUNT(*)::int AS n
        FROM novo_crm_person_cache c
        LEFT JOIN LATERAL (
          SELECT d.value
          FROM jsonb_each(COALESCE(c.raw_data->'dealsById', '{}'::jsonb)) AS d(key, value)
          WHERE c.primary_deal_id IS NOT NULL
            AND d.key = c.primary_deal_id
          LIMIT 1
        ) deal ON true
        WHERE c.is_deleted = false
          AND c.primary_deal_id IS NOT NULL
        GROUP BY 1
        ORDER BY n DESC
      `);
      const byStage = {};
      for (const r of q.rows) byStage[r.stage] = r.n;
      return { by_stage: byStage, total: q.rows.reduce((a, r) => a + r.n, 0) };
    } finally {
      await pool.end();
    }
  } catch (err) {
    return { error: String(err?.message || err) };
  }
}

const now = new Date();
const matSnap = await baseUploadRepo.getLatestSnapshot('matriculados');
if (!matSnap?.id) {
  console.error('Snapshot matriculados ausente');
  process.exit(1);
}

const { set: remat, snap: rematSnap } = await loadIdSetFromBase('rematricula');
let caa = new Set();
try {
  caa = await caaProtocolsRepo.loadOpenCaaIdSet();
} catch (err) {
  console.warn(`CAA open set skip: ${err?.message || err}`);
}

/** @type {Map<string, Record<string, unknown>>} */
const byRgm = new Map();
/** @type {Map<string, Record<string, unknown>>} */
const byCpf = new Map();
let rawRows = 0;
let noRgmNoCpf = 0;

await baseUploadRepo.forEachRowDataForSnapshot('matriculados', matSnap.id, (row) => {
  rawRows += 1;
  const m = extractMatriculadosMappedValues(row);
  const cpf = digits(m.cpf);
  const rgm = digits(m.rgm);
  if (rgm) keepBestRow(byRgm, rgm, row);
  if (cpf.length >= 11) keepBestRow(byCpf, cpf, row);
  if (!rgm && cpf.length < 11) noRgmNoCpf += 1;
});

const byRgmCounts = emptyCounters();
for (const row of byRgm.values()) {
  bump(byRgmCounts, classifyRow(row, remat, caa, now));
}

const byCpfCounts = emptyCounters();
for (const row of byCpf.values()) {
  bump(byCpfCounts, classifyRow(row, remat, caa, now));
}

const cacheStages = await optionalCacheStageCounts();

const result = {
  simulated_at: now.toISOString(),
  simulated_at_brt: now.toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' }),
  rule: 'classifyMatriculado (CANCEL/TRANC→Perdido; CAA open→Retenção; remat→Sem Rematricula; acolhimento; Pós/Graduação)',
  snapshots: {
    matriculados: {
      id: matSnap.id,
      file_name: matSnap.file_name || matSnap.original_filename || null,
      created_at: matSnap.created_at || null,
      row_count: matSnap.row_count ?? rawRows,
    },
    rematricula: rematSnap
      ? {
          id: rematSnap.id,
          file_name: rematSnap.file_name || rematSnap.original_filename || null,
          created_at: rematSnap.created_at || null,
          row_count: rematSnap.row_count ?? null,
          id_keys: remat.size,
        }
      : null,
    caa_open: { id_keys: caa.size },
  },
  input: {
    raw_rows: rawRows,
    distinct_rgm: byRgm.size,
    distinct_cpf: byCpf.size,
    rows_sem_rgm_nem_cpf: noRgmNoCpf,
  },
  by_rgm: byRgmCounts,
  by_cpf: byCpfCounts,
  cache_primary_deal_stages: cacheStages,
};

const ts = Date.now();
const outPath = path.join(ROOT, 'data', `stage-sim-${ts}.json`);
fs.mkdirSync(path.dirname(outPath), { recursive: true });
fs.writeFileSync(outPath, JSON.stringify(result, null, 2), 'utf8');

function printTable(label, counts) {
  console.log(`\n=== ${label} (n=${counts.rows}) ===`);
  const stages = Object.entries(counts.by_stage).sort((a, b) => b[1] - a[1]);
  for (const [name, n] of stages) {
    const pct = counts.rows ? ((n / counts.rows) * 100).toFixed(1) : '0.0';
    console.log(`  ${name.padEnd(18)} ${String(n).padStart(7)}  (${pct}%)`);
  }
  const b = counts.breakout;
  console.log('  --- breakout ---');
  console.log(`  TRANCADO→Perdido     ${b.perdido_trancado}`);
  console.log(`  CANCEL→Perdido       ${b.perdido_cancelado}`);
  console.log(`  TRANC+CANCEL→Perdido ${b.perdido_ambos}`);
  console.log(`  CAA→Retenção         ${b.retencao_caa}`);
  console.log(`  remat→Sem Rematricula ${b.sem_rematricula}`);
  console.log(`  Acolhimento          ${b.acolhimento}`);
  console.log(`  Graduação            ${b.graduacao} (default não-grad/não-pós: ${b.graduacao_default_nao_grad_nem_pos})`);
  console.log(`  Pós                  ${b.pos}`);
}

console.log('Stage sim Novo CRM (dry, sem writes)');
console.log(`Simulado em: ${result.simulated_at_brt} BRT`);
console.log(
  `Matriculados snap: ${matSnap.id} | created_at=${matSnap.created_at || '?'} | raw_rows=${rawRows}`
);
console.log(
  `Rematrícula snap: ${rematSnap?.id || '—'} | keys=${remat.size}`
);
console.log(`CAA open (caa_protocols): keys=${caa.size}`);
printTable('Por RGM (1 deal / RGM)', byRgmCounts);
printTable('Por CPF (1 pessoa / CPF — melhor linha)', byCpfCounts);
if (cacheStages?.by_stage) {
  console.log('\n=== Cache local (primary deal stage, referência) ===');
  for (const [name, n] of Object.entries(cacheStages.by_stage)) {
    console.log(`  ${name.padEnd(22)} ${String(n).padStart(7)}`);
  }
  console.log(`  total deals com stage: ${cacheStages.total}`);
} else if (cacheStages?.error) {
  console.log(`\n(cache stages skip: ${cacheStages.error})`);
}
console.log(`\nJSON: ${outPath}`);
