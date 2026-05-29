import 'dotenv/config';
import {
  countByStatus,
  getDailyTransitionStats,
  listRecentTransitions,
} from '../repositories/caaProtocolsRepository.js';

const since = new Date(Date.now() - 24 * 60 * 60 * 1000);
console.log('janela:', since.toISOString(), '→ agora');

const t = await getDailyTransitionStats({ since });
console.log('\ntransições (últimas 24h):', t);

const c = await countByStatus();
console.log('\nestado atual:', c);

const recent = await listRecentTransitions({ since, limit: 10 });
console.log('\namostra transições:');
for (const r of recent) {
  console.log(
    `  ${r.changed_at.toISOString()} ${r.protocolo} ${r.from_status ?? 'null'} → ${r.to_status} (${r.nome ?? '?'})`
  );
}
process.exit(0);
