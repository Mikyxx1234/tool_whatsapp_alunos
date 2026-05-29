import '../boot-env.js';
import { query } from '../db/client.js';

const { rows: latest } = await query(
  `select id from processos_caa_snapshots order by created_at desc limit 1`
);
const latestId = latest[0].id;
console.log('último snapshot:', latestId);

const { rows: unknowns } = await query(
  `select protocolo, status, last_snapshot_id, first_snapshot_id, nome, rgm
     from caa_protocols
    where status = 'unknown'
      and last_snapshot_id = $1
    order by protocolo
    limit 10`,
  [latestId]
);
console.log('\n=== unknowns com last_snapshot_id = ÚLTIMO ===');
console.log('total:', unknowns.length);
for (const u of unknowns) {
  console.log(`  [${u.protocolo?.slice(0,80)}] | rgm=${u.rgm} | nome=${u.nome}`);
}

const { rows: countAll } = await query(
  `select count(*)::int as n from caa_protocols where status='unknown' and last_snapshot_id = $1`,
  [latestId]
);
console.log('\ntotal unknown no último snapshot:', countAll[0].n);

const { rows: countOther } = await query(
  `select last_snapshot_id, count(*)::int as n
     from caa_protocols where status='unknown'
     group by last_snapshot_id
     order by n desc`
);
console.log('\ndistribuição de unknowns por last_snapshot_id:');
for (const r of countOther) console.log(`  ${r.n} | ${r.last_snapshot_id}`);

process.exit(0);
