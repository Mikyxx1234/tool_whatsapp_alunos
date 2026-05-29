import 'dotenv/config';
import { query } from '../db/client.js';
import { getIntersectionActivationList, invalidateActivationListCache } from '../services/activationService.js';

const matSnap = (await query('select id from matriculados_snapshots order by created_at desc limit 1')).rows[0].id;
const finSnap = (await query('select id from financeiro_snapshots order by created_at desc limit 1')).rows[0].id;

const mats = await query(
  `select data->>'Nome' n, data->>'RGM' r, data->>'Email' e
   from matriculados_rows where snapshot_id=$1 and upper(data->>'Nome') like '%ABNER%ALMEIDA%'`,
  [matSnap]
);
console.log('mat Abner rows:', mats.rows);

const fins = await query(
  `select data->>'Aluno' n, data->>'RGM' r, data->>'Email' e, data->>'Valor_devido' v
   from financeiro_rows where snapshot_id=$1 and upper(data->>'Aluno') like '%ABNER%ALMEIDA%'`,
  [finSnap]
);
console.log('fin Abner rows:', fins.rows);

invalidateActivationListCache('financeiro');
const list = await getIntersectionActivationList('financeiro', { excludeDispatched: false });
const abners = list.items.filter((i) => /abner/i.test(i.nome || ''));
console.log('activation Abners:', abners);

process.exit(0);
