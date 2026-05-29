/**
 * Move RGMs ERP (+136102-10 / 13xxxxxx convertidos) para RGM_erp_matricula e limpa RGM.
 */
import 'dotenv/config';
import { query } from '../db/client.js';
import {
  isLikelyErpMatriculaRgm,
  normalizeMatriculadosRowRgms,
} from '../utils/rgmDisplay.js';
import { invalidateActivationListCache } from '../services/activationService.js';
import { invalidateComparisonCache } from '../services/baseComparisonService.js';
import { invalidateOverviewCache } from '../services/reportOverviewCache.js';

const BATCH = 500;
const { rows } = await query('select id, data from matriculados_rows');
let updated = 0;
/** @type {{ id: string, data: Record<string, unknown> }[]} */
let pending = [];

for (const r of rows) {
  const rgm = r.data?.RGM;
  if (!isLikelyErpMatriculaRgm(rgm)) continue;
  pending.push({ id: r.id, data: normalizeMatriculadosRowRgms(r.data) });
  if (pending.length >= BATCH) {
    const ids = pending.map((x) => x.id);
    const payloads = pending.map((x) => JSON.stringify(x.data));
    await query(
      `update matriculados_rows as t set data = v.data::jsonb
       from unnest($1::uuid[], $2::text[]) as v(id, data) where t.id = v.id`,
      [ids, payloads]
    );
    updated += pending.length;
    pending = [];
  }
}

if (pending.length) {
  const ids = pending.map((x) => x.id);
  const payloads = pending.map((x) => JSON.stringify(x.data));
  await query(
    `update matriculados_rows as t set data = v.data::jsonb
     from unnest($1::uuid[], $2::text[]) as v(id, data) where t.id = v.id`,
    [ids, payloads]
  );
  updated += pending.length;
}

console.log(`matriculados: ${updated}/${rows.length} RGMs ERP movidos para RGM_erp_matricula`);

invalidateComparisonCache();
invalidateOverviewCache();
invalidateActivationListCache();
invalidateActivationListCache('financeiro');

process.exit(0);
