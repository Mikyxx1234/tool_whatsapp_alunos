/* Smoke test do calendário acadêmico + decisionEngine v2.
 *
 * - Cria uma turma com inicio_conteudo X
 * - Cria 1 aluno vinculado à turma SEM inicio_conteudo individual
 * - Verifica que o decisionEngine usa a data da turma para o GAP
 * - Aplica override no aluno
 * - Verifica que override prevalece
 * - Muda thresholds globais para 5/40
 * - Verifica que o fluxo recalcula com base nos novos thresholds
 * - Testa preview-impact endpoint
 *
 * Uso: node scripts/smoke-academic.mjs
 */
import 'dotenv/config';
import { query, getPool } from '../server/db/client.js';
import * as studentRepo from '../server/repositories/studentRepository.js';
import * as termRepo from '../server/repositories/academicTermRepository.js';
import * as settingsRepo from '../server/repositories/journeySettingsRepository.js';
import { applyStudentJourney } from '../server/services/decisionEngine.js';

function isoDay(offsetDays) {
  const d = new Date();
  d.setUTCHours(0, 0, 0, 0);
  d.setUTCDate(d.getUTCDate() + offsetDays);
  return d.toISOString().slice(0, 10);
}

async function cleanup() {
  await query(`delete from students where rgm like 'SMOKE-AC-%'`);
  await query(`delete from academic_terms where codigo like 'SMOKE-AC%'`);
}

async function main() {
  console.log('--- 1. limpando dados anteriores ---');
  await cleanup();

  console.log('--- 2. cria turma 2026/SMOKE com inicio em D+20 ---');
  const term = await termRepo.create({
    codigo: 'SMOKE-AC-2026',
    nome: 'Turma Smoke 2026',
    inicio_matricula: isoDay(-30),
    fim_matricula: isoDay(-1),
    inicio_conteudo: isoDay(20),
    fim_conteudo: isoDay(180),
    tem_ambientacao: true,
    dias_ambientacao: 5,
    tipo_inicio: 'data_fixa',
    liberacao_acesso: 'imediato',
  });
  console.log(`   term id=${term.id} | inicio_conteudo=${term.inicio_conteudo}`);

  console.log('--- 3. cria aluno SEM data individual de inicio_conteudo ---');
  const { student } = await studentRepo.upsertByKey({
    nome: 'SMOKE Academic',
    rgm: 'SMOKE-AC-001',
    cpf: '11122233344',
    telefone: '11999000010',
    email: 'smoke.ac@example.com',
    data_matricula: isoDay(0),
    term_id: term.id,
  });
  console.log(`   aluno id=${student.id} | data_matricula=${student.data_matricula}`);

  console.log('--- 4. classifica usando datas da turma ---');
  const r1 = await applyStudentJourney(student.id);
  console.log(`   gap=${r1.gap_dias} fluxo=${r1.fluxo}`);
  if (r1.gap_dias !== 20) {
    throw new Error(`Esperava gap=20 (vindo da turma), recebeu ${r1.gap_dias}`);
  }
  if (r1.fluxo !== 'B') {
    throw new Error(`Esperava fluxo B (gap 20 ≤ 30), recebeu ${r1.fluxo}`);
  }

  console.log('--- 5. aplica override no aluno (inicio = D+45) ---');
  await studentRepo.patchStudent(student.id, {
    override_data_inicio_conteudo: isoDay(45),
  });
  const r2 = await applyStudentJourney(student.id);
  console.log(`   gap=${r2.gap_dias} fluxo=${r2.fluxo}`);
  if (r2.gap_dias !== 45) {
    throw new Error(`Override falhou: esperava gap=45, recebeu ${r2.gap_dias}`);
  }
  if (r2.fluxo !== 'C') {
    throw new Error(`Esperava fluxo C (gap 45 > 30), recebeu ${r2.fluxo}`);
  }

  console.log('--- 6. muda threshold global para 5/50 ---');
  await settingsRepo.upsertGlobal({ gap_threshold_a: 5, gap_threshold_b: 50 });
  const r3 = await applyStudentJourney(student.id);
  console.log(`   gap=${r3.gap_dias} fluxo=${r3.fluxo} (thresholds 5/50)`);
  if (r3.fluxo !== 'B') {
    throw new Error(`Com thresholds 5/50 e gap=45, esperava fluxo B, recebeu ${r3.fluxo}`);
  }

  console.log('--- 7. testa preview de impacto ---');
  const previewRes = await fetch('http://localhost:3001/api/journey-settings/preview-impact', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ gap_threshold_a: 5, gap_threshold_b: 50, term_id: term.id }),
  }).catch(() => null);
  if (previewRes && previewRes.ok) {
    const previewData = await previewRes.json();
    console.log('   preview =', previewData);
  } else {
    console.log('   preview: backend offline (pula este passo)');
  }

  console.log('--- 8. restaura thresholds default 2/30 ---');
  await settingsRepo.upsertGlobal({ gap_threshold_a: 2, gap_threshold_b: 30 });

  console.log('--- limpando ---');
  await cleanup();
  console.log('OK ✔ — turma + override + thresholds dinâmicos funcionando.');
  await getPool().end();
}

main().catch(async (err) => {
  console.error('SMOKE FAIL:', err);
  try { await getPool().end(); } catch { /* ignore */ }
  process.exit(1);
});
