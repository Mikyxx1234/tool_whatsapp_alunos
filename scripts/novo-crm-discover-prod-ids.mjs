/**
 * Descobre IDs de etapas + custom fields no CRM configurado (PROD/DEV)
 * via GET /api/pipelines + /api/custom-fields. Emite bloco de env.
 *
 * Uso:
 *   node --env-file=.env scripts/novo-crm-discover-prod-ids.mjs
 *   node --env-file=.env scripts/novo-crm-discover-prod-ids.mjs --pipeline=ACADÊMICO
 *
 * Não escreve no CRM.
 */

const pipelineWant = String(
  (process.argv.find((a) => a.startsWith('--pipeline=')) || '').split('=')[1] || 'ACADÊMICO'
)
  .trim()
  .toUpperCase();

process.env.NOVO_CRM_ENABLED = process.env.NOVO_CRM_ENABLED || '1';

const base = String(process.env.NOVO_CRM_API_BASE_URL || '')
  .trim()
  .replace(/\/$/, '');
const token = String(process.env.NOVO_CRM_API_TOKEN || '').trim();
if (!base || !token) {
  console.error('[discover] NOVO_CRM_API_BASE_URL e NOVO_CRM_API_TOKEN obrigatórios');
  process.exit(2);
}

async function apiGet(path) {
  const res = await fetch(`${base}${path}`, {
    headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`${path} → ${res.status} ${text.slice(0, 200)}`);
  return text ? JSON.parse(text) : null;
}

function norm(s) {
  return String(s || '')
    .trim()
    .toLowerCase()
    .normalize('NFD')
    .replace(/\p{M}/gu, '');
}

console.log(`[discover] base=${base} pipelineWant=${pipelineWant || '(default)'}`);

const pipelines = await apiGet('/api/pipelines');
const list = Array.isArray(pipelines) ? pipelines : pipelines?.items || [];
console.log(`[discover] pipelines: ${list.map((p) => p.name).join(' | ')}`);

let pipeline =
  list.find((p) => norm(p.name) === norm(pipelineWant)) ||
  list.find((p) => p.isDefault) ||
  list[0];
if (!pipeline) {
  console.error('[discover] nenhum pipeline encontrado');
  process.exit(1);
}
console.log(`[discover] usando pipeline=${pipeline.name} id=${pipeline.id}`);

const stages = Array.isArray(pipeline.stages) ? pipeline.stages : [];
if (!stages.length) {
  // fallback: /api/stages filtrado
  const all = await apiGet('/api/stages');
  const arr = Array.isArray(all) ? all : all?.items || [];
  for (const s of arr) {
    if (s.pipelineId === pipeline.id) stages.push(s);
  }
}
console.log('[discover] etapas:');
for (const s of [...stages].sort((a, b) => (a.position ?? 0) - (b.position ?? 0))) {
  console.log(`  [${s.position ?? '?'}] ${s.name}  ${s.id}`);
}

function mapStageEnv(name) {
  const n = norm(name);
  if (n.includes('acolh')) return 'NOVO_CRM_STAGE_ACOLHIMENTO';
  if ((n.includes('pos') && n.includes('grad')) || n === 'pos' || n.startsWith('pos ')) {
    return 'NOVO_CRM_STAGE_POS';
  }
  if (n.includes('gradu')) return 'NOVO_CRM_STAGE_GRADUACAO';
  if (n.includes('reten')) return 'NOVO_CRM_STAGE_RETENCAO';
  if (n.includes('remat')) return 'NOVO_CRM_STAGE_SEM_REMATRICULA';
  if (n.includes('cancel')) return 'NOVO_CRM_STAGE_CANCELADO';
  if (n.includes('ganho') || n === 'won') return 'NOVO_CRM_STAGE_GANHO';
  if (n.includes('perd')) return 'NOVO_CRM_STAGE_PERDIDO';
  if (n.includes('entrada') || n.includes('lead de')) return 'NOVO_CRM_STAGE_LEAD_ENTRADA';
  return null;
}

/** @type {Map<string, string>} */
const stageEnvMap = new Map();
for (const s of stages) {
  const envKey = mapStageEnv(s.name);
  if (envKey && !stageEnvMap.has(envKey)) stageEnvMap.set(envKey, s.id);
}

const fieldsRaw = await apiGet('/api/custom-fields?entity=deal');
const fields = Array.isArray(fieldsRaw) ? fieldsRaw : fieldsRaw?.items || [];
console.log(`[discover] custom fields deal: ${fields.length}`);

/** Exact name → env (prefer over fuzzy). */
const EXACT_FIELD = {
  cpf: 'NOVO_CRM_FIELD_CPF',
  rgm: 'NOVO_CRM_FIELD_RGM',
  curso: 'NOVO_CRM_FIELD_CURSO',
  polo: 'NOVO_CRM_FIELD_POLO',
  situacao: 'NOVO_CRM_FIELD_SITUACAO',
  situacaomatricula: 'NOVO_CRM_FIELD_SITUACAO',
  nivel: 'NOVO_CRM_FIELD_NIVEL',
  email: 'NOVO_CRM_FIELD_EMAIL',
  e_mail_ad: 'NOVO_CRM_FIELD_EMAIL_AD',
  email_ad: 'NOVO_CRM_FIELD_EMAIL_AD',
  nasc: 'NOVO_CRM_FIELD_NASC',
  data_nascimento: 'NOVO_CRM_FIELD_NASC',
  acessoblack: 'NOVO_CRM_FIELD_ACESSO_BLACK',
  acesso_black: 'NOVO_CRM_FIELD_ACESSO_BLACK',
  doc_pendentes: 'NOVO_CRM_FIELD_DOC_PENDENTES',
  docpendente: 'NOVO_CRM_FIELD_DOC_PENDENTES',
  docs_pendentes: 'NOVO_CRM_FIELD_DOC_PENDENTES',
  inadimplente: 'NOVO_CRM_FIELD_INADIMPLENTE',
  evasao: 'NOVO_CRM_FIELD_EVASAO',
};

/** @type {Map<string, string>} */
const fieldEnvMap = new Map();
for (const f of fields) {
  const n = norm(f.name).replace(/\s+/g, '_');
  const envKey = EXACT_FIELD[n];
  if (envKey && !fieldEnvMap.has(envKey)) fieldEnvMap.set(envKey, f.id);
}
// Fuzzy only for still-missing keys (avoid data_de_evasao stealing evasao).
for (const f of fields) {
  const n = norm(f.name);
  const l = norm(f.label);
  const blob = `${n} ${l}`;
  /** @type {string|null} */
  let envKey = null;
  if (!fieldEnvMap.has('NOVO_CRM_FIELD_INADIMPLENTE') && (n.includes('inad') || l.includes('inad'))) {
    envKey = 'NOVO_CRM_FIELD_INADIMPLENTE';
  } else if (!fieldEnvMap.has('NOVO_CRM_FIELD_EMAIL') && n === 'email') {
    envKey = 'NOVO_CRM_FIELD_EMAIL';
  } else if (
    !fieldEnvMap.has('NOVO_CRM_FIELD_NASC') &&
    (n === 'nasc' || n.includes('nascimento'))
  ) {
    envKey = 'NOVO_CRM_FIELD_NASC';
  } else if (
    !fieldEnvMap.has('NOVO_CRM_FIELD_DOC_PENDENTES') &&
    (n.includes('doc') || blob.includes('documento'))
  ) {
    envKey = 'NOVO_CRM_FIELD_DOC_PENDENTES';
  }
  if (envKey && !fieldEnvMap.has(envKey)) fieldEnvMap.set(envKey, f.id);
}

const requiredStages = [
  'NOVO_CRM_STAGE_ACOLHIMENTO',
  'NOVO_CRM_STAGE_GRADUACAO',
  'NOVO_CRM_STAGE_POS',
  'NOVO_CRM_STAGE_RETENCAO',
  'NOVO_CRM_STAGE_SEM_REMATRICULA',
  'NOVO_CRM_STAGE_CANCELADO',
  'NOVO_CRM_STAGE_GANHO',
  'NOVO_CRM_STAGE_PERDIDO',
];
const requiredFields = ['NOVO_CRM_FIELD_CPF', 'NOVO_CRM_FIELD_RGM'];
const flagFields = [
  'NOVO_CRM_FIELD_DOC_PENDENTES',
  'NOVO_CRM_FIELD_INADIMPLENTE',
  'NOVO_CRM_FIELD_ACESSO_BLACK',
  'NOVO_CRM_FIELD_EVASAO',
];

const missingStages = requiredStages.filter((k) => !stageEnvMap.has(k));
const missingFields = requiredFields.filter((k) => !fieldEnvMap.has(k));
const missingFlags = flagFields.filter((k) => !fieldEnvMap.has(k));

console.log('\n# --- cole no .env (PROD) ---');
console.log(`# base=${base} pipeline=${pipeline.name}`);
for (const k of requiredStages) {
  const v = stageEnvMap.get(k);
  console.log(v ? `${k}=${v}` : `# MISSING ${k}`);
}
if (stageEnvMap.has('NOVO_CRM_STAGE_LEAD_ENTRADA')) {
  console.log(`NOVO_CRM_STAGE_LEAD_ENTRADA=${stageEnvMap.get('NOVO_CRM_STAGE_LEAD_ENTRADA')}`);
}
for (const k of [
  ...requiredFields,
  'NOVO_CRM_FIELD_CURSO',
  'NOVO_CRM_FIELD_POLO',
  'NOVO_CRM_FIELD_SITUACAO',
  'NOVO_CRM_FIELD_NIVEL',
  'NOVO_CRM_FIELD_EMAIL',
  'NOVO_CRM_FIELD_EMAIL_AD',
  'NOVO_CRM_FIELD_NASC',
]) {
  const v = fieldEnvMap.get(k);
  console.log(v ? `${k}=${v}` : `# MISSING ${k}`);
}

console.log('\n# fields raw:');
for (const f of [...fields].sort((a, b) => String(a.name).localeCompare(String(b.name)))) {
  console.log(`#   ${f.name} = ${f.id} (${f.label || ''})`);
}

if (missingFlags.length) {
  console.warn('[discover] flags sem campo em PROD (sync vai pular):', missingFlags);
}
if (missingStages.length || missingFields.length) {
  console.error('\n[discover] FALTANDO:', { missingStages, missingFields });
  process.exit(1);
}

// Write machine-readable sidecar for other scripts
const out = {
  base,
  pipeline: { id: pipeline.id, name: pipeline.name },
  stages: Object.fromEntries(stageEnvMap),
  fields: Object.fromEntries(fieldEnvMap),
  stagesByName: (() => {
    /** @type {Record<string, string>} */
    const m = {};
    for (const s of stages) {
      if (s?.name && s?.id && !m[s.name]) m[s.name] = s.id;
    }
    return m;
  })(),
};
const fs = await import('node:fs');
const outPath = new URL('../data/novo-crm-prod-ids.json', import.meta.url);
fs.mkdirSync(new URL('../data', import.meta.url), { recursive: true });
fs.writeFileSync(outPath, JSON.stringify(out, null, 2));
console.log(`\n[discover] OK — salvo em data/novo-crm-prod-ids.json`);
process.exit(0);
