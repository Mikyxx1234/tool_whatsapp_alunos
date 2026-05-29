/* Smoke test do scheduler in-process da Régua Inteligente.
 * Cria 1 aluno fictício, agenda um evento `pending` no passado,
 * roda 1 ciclo do scheduler e valida que o evento foi processado.
 *
 * Uso: node scripts/smoke-scheduler.mjs
 *
 * Observação: como o EMAIL_PROVIDER default é "mock" e o scheduler vai
 * tentar enviar via WhatsApp Cloud API se o aluno tiver telefone,
 * este teste cria o evento como `email` para usar o stub e não bater
 * em nenhuma API externa.
 */
import 'dotenv/config';
import { query, getPool } from '../server/db/client.js';
import * as studentRepo from '../server/repositories/studentRepository.js';
import * as scheduledEventRepo from '../server/repositories/scheduledEventRepository.js';
import { runSingleCycle } from '../server/services/schedulerService.js';

async function cleanup() {
  await query(`delete from scheduled_events where metadata->>'smoke' = '1'`);
  await query(`delete from students where nome = 'SMOKE SCHEDULER'`);
}

async function main() {
  console.log('--- 1. limpando estado anterior ---');
  await cleanup();

  console.log('--- 2. criando aluno fictício ---');
  const { student } = await studentRepo.upsertByKey({
    nome: 'SMOKE SCHEDULER',
    telefone: '11999111111',
    email: 'smoke@example.com',
    cpf: '11199911111',
    data_matricula: new Date().toISOString().slice(0, 10),
    data_inicio_conteudo: new Date(Date.now() + 86400000).toISOString().slice(0, 10),
  });
  console.log('   aluno id =', student.id);

  console.log('--- 3. inserindo evento pending no passado (canal=email/mock) ---');
  const pastDate = new Date(Date.now() - 60_000);
  const [event] = await scheduledEventRepo.bulkInsert([
    {
      student_id: student.id,
      canal: 'email',
      event_type: 'D0',
      execution_date: pastDate,
      max_attempts: 3,
      metadata: { smoke: '1', label: 'smoke-scheduler' },
    },
  ]);
  console.log('   event id =', event.id, '| status inicial =', event.status);

  console.log('--- 4. rodando 1 ciclo do scheduler ---');
  const result = await runSingleCycle();
  console.log('   ciclo:', result);

  console.log('--- 5. verificando estado pós-execução ---');
  const { rows } = await query(
    `select id, status, attempts, processed_at, last_error
       from scheduled_events
      where id = $1`,
    [event.id]
  );
  const after = rows[0];
  console.log('   estado:', after);

  if (!after) throw new Error('Evento sumiu da tabela?');
  if (after.status !== 'sent') {
    throw new Error(
      `Esperava status='sent', recebeu '${after.status}' (last_error=${after.last_error})`
    );
  }

  console.log('--- limpando ---');
  await cleanup();
  console.log('OK ✔ — scheduler claimou + processou + persistiu o sent.');
  await getPool().end();
}

main().catch(async (err) => {
  console.error('SMOKE FAIL:', err);
  try { await getPool().end(); } catch { /* ignore */ }
  process.exit(1);
});
