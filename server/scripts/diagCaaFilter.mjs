import '../boot-env.js';
import { query } from '../db/client.js';
import { caaCancelamentoSqlWhere } from '../utils/caaRowFilters.js';
import { buildMatriculadosComparison, invalidateComparisonCache } from '../services/baseComparisonService.js';

const { rows: snaps } = await query(
  `select id, row_count from processos_caa_snapshots order by created_at desc limit 1`
);
const snap = snaps[0];
const w = caaCancelamentoSqlWhere();
const { rows: filtered } = await query(
  `select count(*)::int as n from processos_caa_rows
    where snapshot_id = $1 and (${w})`,
  [snap.id]
);
const { rows: c1 } = await query(
  `select count(*)::int as n from processos_caa_rows
    where snapshot_id = $1 and lower(coalesce(data->>'Subprocesso','')) like '%cancelamento%'`,
  [snap.id]
);
const { rows: sample } = await query(
  `select distinct data->>'Subprocesso' as sub from processos_caa_rows
    where snapshot_id = $1 and data->>'Subprocesso' ilike '%cancel%'
    limit 5`,
  [snap.id]
);
console.log('snapshot rows', snap.row_count, 'filtered', filtered[0].n, 'cancel only', c1[0].n, 'where=', w);
console.log('samples', sample.map((r) => r.sub));

invalidateComparisonCache();
const d = await buildMatriculadosComparison();
const caa = d.comparisons.find((c) => c.id === 'processos-caa');
console.log('caa block', {
  intersecao: caa?.intersecao,
  na_outra_rows: caa?.na_outra_rows,
  na_outra_distintos: caa?.na_outra_distintos,
});
