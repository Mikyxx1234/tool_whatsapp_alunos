/**
 * Carrega os snapshots CAA já existentes (do mais antigo para o mais novo)
 * e reconstrói a tabela caa_protocols + transições.
 *
 * Uso:
 *   node server/scripts/backfillCaaProtocols.mjs
 *   node server/scripts/backfillCaaProtocols.mjs --reset   (limpa antes)
 */
import 'dotenv/config';
import { query } from '../db/client.js';
import { processSnapshot } from '../services/caaProtocolsService.js';

const reset = process.argv.includes('--reset');

if (reset) {
  console.log('Limpando caa_protocols e caa_protocol_transitions…');
  await query('truncate table caa_protocol_transitions');
  await query('truncate table caa_protocols cascade');
}

const { rows: snaps } = await query(
  `select id, file_name, row_count, created_at
     from processos_caa_snapshots
    order by created_at asc`
);

console.log(`${snaps.length} snapshot(s) a processar.`);
for (const s of snaps) {
  console.log(`→ ${s.created_at.toISOString().slice(0, 19)} ${s.file_name} (${s.row_count} linhas)`);
  await processSnapshot(s.id);
}

const { rows: counts } = await query(
  `select status, count(*)::int n from caa_protocols group by status order by n desc`
);
console.log('\nEstado final:');
for (const c of counts) console.log(`  ${c.status.padEnd(20)} ${c.n}`);

const { rows: transTotal } = await query('select count(*)::int n from caa_protocol_transitions');
console.log(`Total transições: ${transTotal[0].n}`);

process.exit(0);
