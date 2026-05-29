import 'dotenv/config';
import { getIntersectionActivationList } from '../services/activationService.js';

const out = await getIntersectionActivationList('processos-caa', { excludeDispatched: false });
console.log('CAA fila — total:', out.total);
console.log('intersection_raw:', out.intersection_raw);
console.log('skipped_already_dispatched:', out.skipped_already_dispatched);
console.log('items:');
for (const it of out.items) {
  console.log(`  ${it.nome.padEnd(40).slice(0, 40)} rgm=${it.rgm} key=${it.master_key}`);
}
process.exit(0);
