/* Smoke test da Régua Inteligente.
 * Cria 3 alunos fictícios com GAPs distintos (ativação imediata, espera curta,
 * espera longa), gera a régua para cada e valida o fluxo + número de eventos.
 *
 * Uso: node scripts/smoke-journey.mjs
 */
import 'dotenv/config';
import { query, getPool } from '../server/db/client.js';
import { calculateStudentJourney } from '../server/services/decisionEngine.js';
import { generateJourneyEventsForStudent } from '../server/services/journeySchedulerService.js';
import * as studentRepo from '../server/repositories/studentRepository.js';

function isoDay(offsetDays) {
  const d = new Date();
  d.setUTCHours(0, 0, 0, 0);
  d.setUTCDate(d.getUTCDate() + offsetDays);
  return d.toISOString().slice(0, 10);
}

async function cleanup() {
  await query(`delete from students where nome like 'SMOKE %'`);
}

const CASES = [
  {
    label: 'Aluno A (ativação imediata)',
    nome: 'SMOKE A',
    telefone: '11999000001',
    cpf: '00000000001',
    data_matricula: isoDay(-1),
    data_inicio_conteudo: isoDay(0),
    expectedFluxo: 'A',
    minEvents: 1,
  },
  {
    label: 'Aluno B (espera curta)',
    nome: 'SMOKE B',
    telefone: '11999000002',
    cpf: '00000000002',
    data_matricula: isoDay(0),
    data_inicio_conteudo: isoDay(15),
    expectedFluxo: 'B',
    minEvents: 1,
  },
  {
    label: 'Aluno C (espera longa)',
    nome: 'SMOKE C',
    telefone: '11999000003',
    cpf: '00000000003',
    data_matricula: isoDay(0),
    data_inicio_conteudo: isoDay(60),
    expectedFluxo: 'C',
    minEvents: 1,
  },
];

async function main() {
  console.log('--- 1. limpando alunos SMOKE existentes ---');
  await cleanup();

  for (const c of CASES) {
    console.log(`\n=== ${c.label} ===`);

    // (a) classifica fora do banco para validar a regra pura
    const pure = calculateStudentJourney({
      data_matricula: c.data_matricula,
      data_inicio_conteudo: c.data_inicio_conteudo,
    });
    console.log(`   pure decision: gap=${pure.gap_dias} fluxo=${pure.fluxo}`);
    if (pure.fluxo !== c.expectedFluxo) {
      throw new Error(
        `Fluxo esperado ${c.expectedFluxo}, recebido ${pure.fluxo} (gap=${pure.gap_dias})`
      );
    }

    // (b) cria aluno e gera régua
    const { student } = await studentRepo.upsertByKey({
      nome: c.nome,
      telefone: c.telefone,
      cpf: c.cpf,
      data_matricula: c.data_matricula,
      data_inicio_conteudo: c.data_inicio_conteudo,
    });
    console.log(`   aluno criado id=${student.id}`);

    const result = await generateJourneyEventsForStudent(student.id);
    console.log(
      `   régua gerada: fluxo=${result.fluxo} gap=${result.gap_dias} eventos=${result.events.length}`
    );
    if (result.fluxo !== c.expectedFluxo) {
      throw new Error(
        `Persistido fluxo ${result.fluxo} (esperado ${c.expectedFluxo})`
      );
    }
    if (result.events.length < c.minEvents) {
      throw new Error(
        `Esperava pelo menos ${c.minEvents} eventos, gerou ${result.events.length}`
      );
    }
    for (const ev of result.events) {
      console.log(
        `     - ${ev.event_type} | ${new Date(ev.execution_date).toISOString()} | template_id=${ev.template_id || '∅'}`
      );
    }
  }

  console.log('\n--- limpando ---');
  await cleanup();
  console.log('OK ✔ — régua inteligente classifica e gera eventos por fluxo.');
  await getPool().end();
}

main().catch(async (err) => {
  console.error('SMOKE FAIL:', err);
  try { await getPool().end(); } catch { /* ignore */ }
  process.exit(1);
});
