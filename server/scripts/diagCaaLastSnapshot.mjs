import 'dotenv/config';
import { query } from '../db/client.js';
import {
  getDailyTransitionStats,
  listRecentSnapshots,
  countByStatus,
} from '../repositories/caaProtocolsRepository.js';

const snaps = await listRecentSnapshots(5);
console.log('=== snapshots CAA (últimos 5) ===');
for (const s of snaps) {
  console.log(`  ${s.created_at} | ${s.file_name} | rows=${s.row_count} | id=${s.id}`);
}

const latest = snaps[0];
if (!latest) {
  console.log('sem snapshots');
  process.exit(0);
}

const { rows: bySnap } = await query(
  `select snapshot_id, count(*)::int as n,
          count(*) filter (where from_status is null)::int as novos,
          count(*) filter (where from_status = 'open')::int as from_open
     from caa_protocol_transitions
    group by snapshot_id
    order by n desc
    limit 10`
);
console.log('\n=== transições por snapshot_id (top 10) ===');
for (const r of bySnap) {
  const mark = r.snapshot_id === latest.id ? ' ← ÚLTIMO' : '';
  console.log(`  ${r.n} total (${r.novos} novos, ${r.from_open} from open) | ${r.snapshot_id}${mark}`);
}

const { rows: totalT } = await query(`select count(*)::int as n from caa_protocol_transitions`);
console.log('\ntotal transições na tabela:', totalT[0].n);

const stats = await getDailyTransitionStats({ snapshotId: latest.id });
console.log('\n=== KPIs scope=last_snapshot (último id) ===', stats);

const statsHours = await getDailyTransitionStats({
  since: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000),
});
console.log('\n=== KPIs scope=hours (30 dias) ===', statsHours);

const current = await countByStatus();
console.log('\n=== estado atual (último snapshot) ===', current);

const { rows: sample } = await query(
  `select t.protocolo, t.from_status, t.to_status, t.changed_at, p.status, p.last_snapshot_id
     from caa_protocol_transitions t
     left join caa_protocols p on p.protocolo = t.protocolo
    where t.snapshot_id = $1
    order by t.changed_at desc
    limit 8`,
  [latest.id]
);
console.log('\n=== amostra transições do último snapshot ===');
for (const r of sample) {
  console.log(
    `  ${r.protocolo} ${r.from_status ?? 'null'}→${r.to_status} | protocol last_snap=${r.last_snapshot_id === latest.id ? 'OK' : 'DIFF'} status=${r.status}`
  );
}

process.exit(0);
