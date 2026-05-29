/**
 * Remove entradas fantasma de caa_protocols cuja "protocolo" não é numérica
 * (resíduo de snapshots processados antes do repair V2).
 *
 * Uso: node server/scripts/cleanupCaaPhantoms.mjs [--dry-run]
 */
import '../boot-env.js';
import { query } from '../db/client.js';

const dryRun = process.argv.includes('--dry-run');

const { rows: phantoms } = await query(
  `select protocolo, rgm, nome, status, last_snapshot_id
     from caa_protocols
    where protocolo !~ '^\\d{9,12}$'`
);
console.log(`Encontradas ${phantoms.length} entradas fantasma (protocolo não numérico 9-12d).`);
if (phantoms.length) {
  for (const p of phantoms.slice(0, 5)) {
    console.log(`  [${p.protocolo?.slice(0, 60)}…] rgm=${p.rgm} status=${p.status}`);
  }
  if (phantoms.length > 5) console.log(`  … e mais ${phantoms.length - 5}`);
}

if (dryRun) {
  console.log('\n[dry-run] nenhuma alteração feita.');
  process.exit(0);
}

const protocolos = phantoms.map((p) => p.protocolo);
if (!protocolos.length) {
  console.log('Nada a remover.');
  process.exit(0);
}

const { rowCount: tRows } = await query(
  `delete from caa_protocol_transitions where protocolo = any($1)`,
  [protocolos]
);
console.log(`Transições removidas: ${tRows}`);

const { rowCount: pRows } = await query(
  `delete from caa_protocols where protocolo = any($1)`,
  [protocolos]
);
console.log(`Protocolos removidos: ${pRows}`);

process.exit(0);
