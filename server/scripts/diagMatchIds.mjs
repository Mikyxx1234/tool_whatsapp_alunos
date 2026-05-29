import 'dotenv/config';
import { query } from '../db/client.js';
import { getIntersectionActivationList } from '../services/activationService.js';
import { invalidateActivationListCache } from '../services/activationService.js';

const matSnap = (await query('select id from matriculados_snapshots order by created_at desc limit 1')).rows[0].id;
const finSnap = (await query('select id from financeiro_snapshots order by created_at desc limit 1')).rows[0].id;

const names = [
  'ABNER SILVA DE ALMEIDA',
  'ABNOAM MARIA DOS SANTOS',
  'ADEMIR MENDES NUNES',
];

for (const nome of names) {
  const mat = await query(
    `select data->>'RGM' rgm, data->>'Email' email from matriculados_rows
     where snapshot_id=$1 and upper(data->>'Nome') like $2 limit 1`,
    [matSnap, `%${nome}%`]
  );
  const fin = await query(
    `select data->>'RGM' rgm, data->>'Aluno' aluno, data->>'Email' email from financeiro_rows
     where snapshot_id=$1 and upper(data->>'Aluno') like $2 limit 1`,
    [finSnap, `%${nome.split(' ')[0]}%${nome.split(' ').slice(-1)[0]}%`]
  );
  console.log('\n', nome);
  console.log('  mat', mat.rows[0]);
  console.log('  fin', fin.rows[0]);
}

invalidateActivationListCache('financeiro');
const list = await getIntersectionActivationList('financeiro', { excludeDispatched: false });
for (const nome of names) {
  const item = list.items.find((i) => i.nome?.includes(nome.split(' ')[0]));
  console.log('  activation', nome, item?.rgm, item?.email);
}

// financeiro RGM column stats
const finRgmSample = await query(
  `select data->>'RGM' rgm from financeiro_rows where snapshot_id=$1 limit 20`,
  [finSnap]
);
console.log('\nfin RGM values sample:', finRgmSample.rows.map((r) => r.rgm));

process.exit(0);
