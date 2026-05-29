import 'dotenv/config';
import { getIntersectionActivationList } from '../services/activationService.js';
import { invalidateActivationListCache } from '../services/activationService.js';

invalidateActivationListCache('financeiro');

const result = await getIntersectionActivationList('financeiro', { excludeDispatched: false });
console.log('intersection', result.intersection_count, 'items', result.items?.length);

const badRgm = result.items.filter((i) => !/^\d{8}$/.test(i.rgm || ''));
const p13 = result.items.filter((i) => /^13\d{6}$/.test(i.rgm || ''));
const p49 = result.items.filter((i) => /^49\d{6}$/.test(i.rgm || ''));
const decimal = result.items.filter((i) => /\./.test(i.rgm || ''));

console.log('bad rgm count', badRgm.length);
console.log('prefix 13', p13.length, 'prefix 49', p49.length, 'decimal', decimal.length);
console.log('amostra primeiros 5:', result.items.slice(0, 5).map((i) => ({ nome: i.nome?.slice(0, 30), rgm: i.rgm, email: i.email?.slice(0, 25) })));

const aline = result.items.filter((i) => /aline.*bitencourt/i.test(i.nome || ''));
console.log('Aline na fila financeiro:', aline);

process.exit(0);
