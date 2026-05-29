import 'dotenv/config';
import { query } from '../db/client.js';
import * as baseUploadRepo from '../repositories/baseUploadRepository.js';
import {
  buildPersonIndexFromSnapshot,
  buildIdentityLookup,
  matchMatriculadoToOtherIndex,
} from '../services/baseComparisonService.js';
import { formatRgmForDisplay, displayRgmFromRow } from '../utils/rgmDisplay.js';

const names = [
  'ADRIANA DOS SANTOS ALMEIDA ALVES',
  'ALDENEIDE MARIA NASCIMENTO DSA SILVA',
];

const matId = (await query('select id from matriculados_snapshots order by created_at desc limit 1')).rows[0].id;
const finId = (await query('select id from financeiro_snapshots order by created_at desc limit 1')).rows[0].id;

for (const name of names) {
  console.log('\n===', name, '===');
  const mat = await query(
    `select data from matriculados_rows where snapshot_id=$1 and upper(trim(data->>'Nome'))=$2 limit 1`,
    [matId, name]
  );
  const fin = await query(
    `select data from financeiro_rows where snapshot_id=$1 and upper(trim(coalesce(data->>'Aluno','')))=$2 limit 1`,
    [matId, name]
  );
  const fin2 = await query(
    `select data from financeiro_rows where snapshot_id=$1 and upper(trim(coalesce(data->>'Aluno',''))) like $2 limit 3`,
    [finId, `%${name.split(' ')[0]}%`]
  );
  console.log('mat RGM raw:', mat.rows[0]?.data?.RGM, 'RG:', mat.rows[0]?.data?.RG);
  console.log('mat display:', displayRgmFromRow(mat.rows[0]?.data || {}));
  console.log('fin exact:', fin.rows[0]?.data?.RGM);
  console.log('fin like:', fin2.rows.map((r) => ({ aluno: r.data.Aluno, rgm: r.data.RGM })));
}

// intersection sample financeiro
const matSnap = await baseUploadRepo.getLatestSnapshot('matriculados');
const finSnap = await baseUploadRepo.getLatestSnapshot('financeiro');
const matIdx = await buildPersonIndexFromSnapshot('matriculados', matSnap.id, { keepSampleRow: true });
const finIdx = await buildPersonIndexFromSnapshot('financeiro', finSnap.id, { keepSampleRow: true });
const finLookup = buildIdentityLookup(finIdx.byCanon);

let n = 0;
for (const entry of matIdx.byCanon.values()) {
  const m = matchMatriculadoToOtherIndex(entry, finIdx.byCanon, finLookup);
  if (m !== 'aligned') continue;
  if (n++ >= 5) break;
  const other = [...finLookup.values()].flat().find((e) =>
    [...entry.ids].some((id) => e.ids.has(id))
  );
  console.log('\n--- match', n, '---');
  console.log('mat nome:', entry.row?.Nome);
  console.log('mat RGM:', entry.row?.RGM, '→', displayRgmFromRow(entry.row));
  console.log('fin RGM:', other?.row?.RGM, '→', displayRgmFromRow(other?.row));
}

// distinct RGM patterns in financeiro
const pats = await query(`
  select
    count(*) filter (where data->>'RGM' ~ '^\\+')::int as com_mais,
    count(*) filter (where data->>'RGM' ~ '^[0-9]{7,9}$')::int as num_7_9,
    count(*) filter (where data->>'RGM' ~ '^[0-9]+\\.[0-9]+$')::int as com_ponto,
    count(*)::int as total
  from financeiro_rows where snapshot_id = $1
`, [finId]);
console.log('\nfinanceiro patterns', pats.rows[0]);

process.exit(0);
