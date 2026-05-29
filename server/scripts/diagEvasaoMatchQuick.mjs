import 'dotenv/config';
import { query } from '../db/client.js';

function normRgm(v) {
  let d = String(v ?? '').replace(/\D/g, '');
  if (d.includes('.') || d.includes('e')) {
    const n = parseFloat(String(v));
    if (Number.isFinite(n) && Number.isInteger(n)) d = String(Math.trunc(n));
  }
  return d;
}

const matSnap = await query(
  'select id from matriculados_snapshots order by created_at desc limit 1'
);
const evSnap = await query(
  'select id from provavel_evasao_snapshots order by created_at desc limit 1'
);

const matRgms = await query(
  `select distinct regexp_replace(coalesce(data->>'RGM', data->>'Rgm', ''), '[^0-9]', '', 'g') as rgm
   from matriculados_rows where snapshot_id = $1 and length(regexp_replace(coalesce(data->>'RGM',''), '[^0-9]', '', 'g')) >= 6
   limit 50000`,
  [matSnap.rows[0].id]
);
const evRgms = await query(
  `select distinct regexp_replace(coalesce(data->>'RGM', ''), '[^0-9]', '', 'g') as rgm
   from provavel_evasao_rows where snapshot_id = $1`,
  [evSnap.rows[0].id]
);

const matSet = new Set(matRgms.rows.map((r) => r.rgm));
let hit = 0;
for (const r of evRgms.rows) {
  if (matSet.has(r.rgm)) hit += 1;
}
console.log('mat distinct rgm (sample query):', matSet.size);
console.log('ev distinct rgm:', evRgms.rows.length);
console.log('intersection SQL rgm:', hit);

const sampleMat = await query(
  `select data->>'RGM' as raw, data->>'Ciclo' as ciclo from matriculados_rows where snapshot_id = $1 limit 5`,
  [matSnap.rows[0].id]
);
const sampleEv = await query(
  `select data->>'RGM' as raw, data->>'Ciclo' as ciclo from provavel_evasao_rows where snapshot_id = $1 limit 5`,
  [evSnap.rows[0].id]
);
console.log('sample mat', sampleMat.rows);
console.log('sample ev', sampleEv.rows);

// check if ev RGM exists in mat at all - one ev rgm
const one = sampleEv.rows[0]?.raw;
const found = await query(
  `select count(*)::int n from matriculados_rows where snapshot_id = $1
   and regexp_replace(coalesce(data->>'RGM',''), '[^0-9]', '', 'g') = regexp_replace($2, '[^0-9]', '', 'g')`,
  [matSnap.rows[0].id, one]
);
console.log('ev first rgm in mat rows?', found.rows[0].n, 'rgm', one);

process.exit(0);
