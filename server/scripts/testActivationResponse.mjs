/**
 * Teste de ponta-a-ponta:
 *   1. Insere resposta fake em activation_responses (uma das 2 pendentes CAA)
 *   2. Lê o roster CAA e mostra o badge esperado
 *
 * Uso:
 *   node server/scripts/testActivationResponse.mjs        (insere e lê)
 *   node server/scripts/testActivationResponse.mjs --clean (remove a resposta fake)
 */
import 'dotenv/config';
import { query } from '../db/client.js';
import { getActivationRoster } from '../services/activationService.js';

const clean = process.argv.includes('--clean');

if (clean) {
  const del = await query(
    `delete from activation_responses where external_id = 'test_evt_caa_001' returning id`
  );
  console.log(`removidas ${del.rowCount} resposta(s) de teste`);
  process.exit(0);
}

const target = (
  await query(
    `select rgm from caa_protocols
       where status='open'
         and last_snapshot_id = (select id from processos_caa_snapshots order by created_at desc limit 1)
       order by rgm limit 1`
  )
).rows[0];

if (!target) {
  console.log('Nenhuma pendente CAA pra testar');
  process.exit(0);
}

const masterKey = `RGM:${target.rgm}`;
console.log(`Inserindo resposta de teste para ${masterKey}…`);

await query(
  `insert into activation_responses (
     category, master_key, rgm, response_kind, button_payload, external_id, raw_payload, received_at
   ) values (
     'processos-caa', $1, $2, 'click', 'Quero manter minha matrícula',
     'test_evt_caa_001', '{"source":"test"}'::jsonb, now() - interval '32 minutes'
   )
   on conflict (external_id) where external_id is not null do nothing`,
  [masterKey, target.rgm]
);

console.log('\nLendo roster CAA…');
const roster = await getActivationRoster('processos-caa', { limit: 10 });
console.log(`total na fila: ${roster.total}`);
for (const it of roster.items) {
  const badge = it.last_response_at
    ? ` [${it.last_response_kind} · "${it.last_response_button ?? ''}" @ ${it.last_response_at}]`
    : '';
  console.log(`  ${it.nome.slice(0, 40).padEnd(40)} rgm=${it.rgm}${badge}`);
}

console.log('\nPara limpar:  node server/scripts/testActivationResponse.mjs --clean');
process.exit(0);
