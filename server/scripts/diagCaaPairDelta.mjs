import 'dotenv/config';
import { getSnapshotPairDelta } from '../services/caaProtocolsService.js';

const d = await getSnapshotPairDelta();
console.log('stats (KPIs):', d.stats);
console.log('total D+1 filtrável:', d.total);

const rev = await getSnapshotPairDelta({ toStatus: ['won_reverted'], limit: 10 });
console.log('\naba Revertidos:', rev.total, 'itens');
for (const t of rev.transitions) {
  console.log(`  ${t.from_status} → ${t.to_status} ${t.nome}`);
}

const perd = await getSnapshotPairDelta({ toStatus: ['lost_canceled', 'lost_confirmed'], limit: 10 });
console.log('\naba Perdidos:', perd.total, 'itens');
console.log('latest:', d.latest?.file_name, d.latest?.created_at);
console.log('previous:', d.previous?.file_name, d.previous?.created_at);
if (d.transitions?.length) {
  console.log('\namostra:');
  for (const t of d.transitions.slice(0, 5)) {
    console.log(`  ${t.protocolo} ${t.from_status ?? 'null'} → ${t.to_status} (${t.nome})`);
  }
}
process.exit(0);
