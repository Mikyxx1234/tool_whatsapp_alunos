/**
 * Repara colunas deslocadas no último snapshot CAA e reprocessa caa_protocols.
 * Uso: node server/scripts/repairLatestCaaSnapshot.mjs
 */
import 'dotenv/config';
import { query } from '../db/client.js';
import { repairCaaExportRow } from '../utils/caaExportRepair.js';
import { processSnapshot } from '../services/caaProtocolsService.js';
import { countStatusInLatestSnapshot } from '../services/caaProtocolsService.js';
import { getSnapshotPairDelta } from '../services/caaProtocolsService.js';

const { rows: snaps } = await query(
  `select id, file_name, row_count, created_at from processos_caa_snapshots order by created_at desc limit 1`
);
const snap = snaps[0];
if (!snap) {
  console.log('Nenhum snapshot CAA');
  process.exit(0);
}
console.log('Reparando snapshot:', snap.file_name, snap.id, snap.row_count, 'linhas');

const { rows } = await query(
  `select snapshot_id, row_index, data from processos_caa_rows where snapshot_id = $1 order by row_index`,
  [snap.id]
);
let repaired = 0;
const CHUNK = 500;
for (let i = 0; i < rows.length; i += CHUNK) {
  const slice = rows.slice(i, i + CHUNK);
  for (const r of slice) {
    const fixed = repairCaaExportRow(r.data);
    if (JSON.stringify(fixed) !== JSON.stringify(r.data)) repaired += 1;
    await query(
      `update processos_caa_rows set data = $1::jsonb where snapshot_id = $2 and row_index = $3`,
      [JSON.stringify(fixed), r.snapshot_id, r.row_index]
    );
  }
  if (i > 0 && i % 5000 === 0) console.log(`  ${i}/${rows.length}…`);
}
console.log(`Linhas reparadas: ${repaired}/${rows.length}`);

const stats = await processSnapshot(snap.id);
console.log('processSnapshot:', stats);

const counts = await countStatusInLatestSnapshot();
const delta = await getSnapshotPairDelta({ toStatus: ['open'], requireCurrentStatus: 'open' });
console.log('Estado atual (último export):', counts);
console.log('Pendentes na fila (dedup RGM):', delta.stats.novos_pendentes);
console.log('open_in_latest:', delta.open_in_latest);
