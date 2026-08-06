/**
 * Cache-only scan: CPF clusters with open deals >> SIAA RGM count.
 * No live API. node scripts/_scan-multi-dup-cache.mjs
 */
import pg from 'pg';
import {
  normalizeCpf,
  normalizeRgm,
} from '../server/utils/novoCrmCacheNormalize.js';
import { extractMatriculadosMappedValues } from '../server/utils/novoCrmFieldMapping.js';
import * as baseUploadRepo from '../server/repositories/baseUploadRepository.js';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
try {
  const dotenv = await import('dotenv');
  dotenv.config({ path: path.join(ROOT, '.env'), override: false });
} catch {
  /* */
}

const PERDIDO = 'cmrwd5vuo014hpd01imhgkp0y';

const matSnap = await baseUploadRepo.getLatestSnapshot('matriculados');
const siaaByCpf = new Map();
await baseUploadRepo.forEachRowDataForSnapshot('matriculados', matSnap.id, (row) => {
  const m = extractMatriculadosMappedValues(row);
  const cpf = normalizeCpf(m.cpf);
  const rgm = normalizeRgm(m.rgm);
  if (!cpf || !rgm) return;
  let s = siaaByCpf.get(cpf);
  if (!s) {
    s = new Set();
    siaaByCpf.set(cpf, s);
  }
  s.add(rgm);
});

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, ssl: false });
const { rows } = await pool.query(`
  SELECT contact_id, nome, cpf_norm, rgm_norm, raw_data
  FROM novo_crm_person_cache WHERE is_deleted = false
`);
await pool.end();

const byCpf = new Map();
function ensure(cpf) {
  let c = byCpf.get(cpf);
  if (!c) {
    c = { deals: new Map(), names: new Set() };
    byCpf.set(cpf, c);
  }
  return c;
}

for (const row of rows) {
  const deals = row.raw_data?.dealsById ? Object.values(row.raw_data.dealsById) : [];
  for (const d of deals) {
    if (!d?.id) continue;
    const stageId = String(d.stageId || d.stage?.id || '');
    if (stageId === PERDIDO) continue;
    const fields = {};
    for (const f of d.customFields || []) {
      const n = String(f.name || '').toLowerCase();
      if (f.value != null) fields[n] = String(f.value);
    }
    const cpf = normalizeCpf(fields.cpf || row.cpf_norm);
    if (!cpf) continue;
    const cl = ensure(cpf);
    cl.names.add(row.nome || d.title || '');
    cl.deals.set(d.id, {
      id: d.id,
      number: d.number,
      title: d.title,
      rgm: normalizeRgm(fields.rgm || row.rgm_norm),
      stage: d.stage?.name || stageId,
    });
  }
}

const flagged = [];
for (const [cpf, cl] of byCpf) {
  const siaa = siaaByCpf.get(cpf);
  if (!siaa) continue;
  const open = cl.deals.size;
  const siaaN = siaa.size;
  if (open <= siaaN) continue;
  const byRgm = new Map();
  for (const d of cl.deals.values()) {
    const k = d.rgm || '(empty)';
    byRgm.set(k, (byRgm.get(k) || 0) + 1);
  }
  flagged.push({
    cpf,
    open,
    siaa: siaaN,
    excess: open - siaaN,
    multi: siaaN > 1,
    same_rgm_spam: [...byRgm.values()].some((n) => n > 1),
    siaa_rgms: [...siaa],
    deal_rgms: Object.fromEntries(byRgm),
    names: [...cl.names].slice(0, 3),
    numbers: [...cl.deals.values()].map((d) => d.number).slice(0, 12),
  });
}
flagged.sort((a, b) => b.excess - a.excess);

const multi = flagged.filter((f) => f.multi);
const spam = flagged.filter((f) => !f.multi && f.same_rgm_spam);

console.log(
  JSON.stringify(
    {
      snapshot: matSnap.id,
      clusters_excess: flagged.length,
      multi_curso_excess: multi.length,
      same_rgm_spam_only: spam.length,
      excess_deals_total: flagged.reduce((s, f) => s + f.excess, 0),
      top20: flagged.slice(0, 20),
    },
    null,
    2
  )
);

const out = path.join(ROOT, 'data', `multi-dup-cache-scan-${Date.now()}.json`);
fs.writeFileSync(
  out,
  JSON.stringify({ flagged, multi, spam_only: spam }, null, 2)
);
console.error('wrote', out);
