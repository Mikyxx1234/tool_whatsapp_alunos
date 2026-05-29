/**
 * Regrava RGM exibível na coluna data (campo rgm_display) — opcional; aqui só corrige leitura via script de teste.
 * Atualiza metadata do snapshot para forçar re-leitura com formatRgm na UI após invalidate.
 */
import 'dotenv/config';
import { recoverFinanceiroDecimalRgm } from '../utils/rgmDisplay.js';
import { query } from '../db/client.js';
import { invalidateActivationListCache } from '../services/activationService.js';
import { invalidateComparisonCache } from '../services/baseComparisonService.js';
import { invalidateOverviewCache } from '../services/reportOverviewCache.js';

const snap = await query(
  'select id from financeiro_snapshots order by created_at desc limit 1'
);
const id = snap.rows[0]?.id;
if (!id) {
  console.log('sem snapshot financeiro');
  process.exit(0);
}

const { rows } = await query(
  'select id, data from financeiro_rows where snapshot_id = $1',
  [id]
);

let updated = 0;
for (const r of rows) {
  const raw = r.data?.RGM;
  const fixed = recoverFinanceiroDecimalRgm(String(raw ?? ''));
  if (!fixed) continue;
  const next = { ...r.data, RGM: fixed, RGM_origem_planilha: raw };
  await query('update financeiro_rows set data = $2::jsonb where id = $1', [
    r.id,
    JSON.stringify(next),
  ]);
  updated += 1;
}

console.log(`Atualizados ${updated} de ${rows.length} RGMs financeiro`);

invalidateActivationListCache();
invalidateActivationListCache('financeiro');
invalidateComparisonCache();
invalidateOverviewCache();

process.exit(0);
