/**
 * Reaplica dedup no último snapshot de provável evasão (maior Evasão Média por RGM+ciclo).
 * Uso: node server/scripts/dedupeProvavelEvasaoSnapshot.mjs
 */
import 'dotenv/config';
import { query } from '../db/client.js';
import * as baseUploadRepo from '../repositories/baseUploadRepository.js';
import { dedupeProvavelEvasaoRows } from '../utils/evasaoDedup.js';
import { invalidateComparisonCache } from '../services/baseComparisonService.js';
import { invalidateOverviewCache } from '../services/reportOverviewCache.js';
import { invalidateActivationListCache } from '../services/activationService.js';

const snap = await baseUploadRepo.getLatestSnapshot('provavel-evasao');
if (!snap) {
  console.log('Nenhum snapshot de provável evasão.');
  process.exit(0);
}

console.log(`Snapshot ${snap.id} — ${snap.file_name} (${snap.row_count} linhas)`);

const objects = await baseUploadRepo.fetchAllRowDataForSnapshot('provavel-evasao', snap.id);
const { rows, removed, skipped_no_key } = dedupeProvavelEvasaoRows(objects);
console.log(
  `Dedup: ${objects.length} → ${rows.length} (removidas ${removed}, sem RGM ${skipped_no_key})`
);

await query('delete from provavel_evasao_rows where snapshot_id = $1', [snap.id]);

const pool = (await import('../db/client.js')).getPool();
const client = await pool.connect();
const INSERT_CHUNK = 3000;
try {
  await client.query('BEGIN');
  for (let i = 0; i < rows.length; i += INSERT_CHUNK) {
    const slice = rows.slice(i, i + INSERT_CHUNK);
    const valueParts = [];
    const params = [];
    let p = 1;
    for (let j = 0; j < slice.length; j += 1) {
      valueParts.push(`($${p++}::uuid, $${p++}::int, $${p++}::jsonb)`);
      params.push(snap.id, i + j, JSON.stringify(slice[j]));
    }
    await client.query(
      `insert into provavel_evasao_rows (snapshot_id, row_index, data) values ${valueParts.join(', ')}`,
      params
    );
  }
  const meta = {
    ...(typeof snap.metadata === 'object' ? snap.metadata : {}),
    provavel_evasao_deduped_at: new Date().toISOString(),
    provavel_evasao_rows_before_dedup: objects.length,
    provavel_evasao_rows_after_dedup: rows.length,
    provavel_evasao_duplicates_removed: removed,
  };
  await client.query(
    `update provavel_evasao_snapshots set row_count = $2, metadata = $3::jsonb where id = $1`,
    [snap.id, rows.length, JSON.stringify(meta)]
  );
  await client.query('COMMIT');
} catch (e) {
  await client.query('ROLLBACK').catch(() => {});
  throw e;
} finally {
  client.release();
}

invalidateComparisonCache();
invalidateOverviewCache();
invalidateActivationListCache('provavel-evasao');

console.log('OK. Recarregue Relatórios → Atualizar.');
