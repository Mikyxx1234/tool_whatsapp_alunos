import '../boot-env.js';
import { query } from '../db/client.js';
import { isCaaRowMisaligned, repairCaaExportRow } from '../utils/caaExportRepair.js';

const snapId = '88d11047-52e9-4984-a901-853f1ad74193';

const { rows } = await query(
  `select data from processos_caa_rows where snapshot_id = $1`,
  [snapId]
);
console.log(`total rows no snapshot: ${rows.length}`);

let cancelMat = 0;
let cancelMatPendDireto = 0;
let cancelMatStatusEmAging = 0;
let cancelMatProtocoloEmDataPrevisao = 0;
let totalMisaligned = 0;
let totalMisalignedRecognized = 0;

for (const r of rows) {
  const d = r.data;
  const sub = String(d?.Subprocesso ?? '').toUpperCase();
  const isCancel = sub.includes('CANCELAMENTO') && sub.includes('MATR');

  const att = String(d?.['Situação Atendimento'] ?? d?.['Situacao Atendimento'] ?? '').toUpperCase();
  const aging = String(d?.['Aging Dias'] ?? '').toUpperCase();
  const dataPrev = String(d?.['Data Previsão'] ?? '').replace(/\D/g, '');

  const attIsTelefone = /^\d{10,13}$/.test(att.replace(/\D/g, ''));
  const agingIsStatus = aging.includes('PEND') || aging.includes('CONCLU') || aging.includes('CANCEL');
  const dataPrevIsProtocolo = dataPrev.length >= 9 && dataPrev.length <= 12;

  if (isCancel) {
    cancelMat++;
    if (att.includes('PEND')) cancelMatPendDireto++;
    if (agingIsStatus && (aging.includes('PEND'))) cancelMatStatusEmAging++;
    if (dataPrevIsProtocolo && (!d?.Protocolo || String(d.Protocolo).replace(/\D/g, '').length < 9)) {
      cancelMatProtocoloEmDataPrevisao++;
    }
  }

  if (isCaaRowMisaligned(d)) totalMisalignedRecognized++;

  if (attIsTelefone || agingIsStatus) totalMisaligned++;
}

console.log('\n=== contagens ===');
console.log('  cancelamento_matricula (subproc):', cancelMat);
console.log('  cancel + pendente em Situação Atendimento:', cancelMatPendDireto);
console.log('  cancel + status em Aging Dias (escondido):', cancelMatStatusEmAging);
console.log('  cancel + protocolo em Data Previsão (escondido):', cancelMatProtocoloEmDataPrevisao);
console.log('  total linhas misaligned (qq padrão detectado):', totalMisaligned);
console.log('  total linhas reconhecidas por isCaaRowMisaligned atual:', totalMisalignedRecognized);

// linhas de cancelamento + tudo
console.log('\n=== 5 linhas de CANCELAMENTO MATRÍCULA ===');
let shown = 0;
for (const r of rows) {
  const d = r.data;
  const sub = String(d?.Subprocesso ?? '').toUpperCase();
  if (!(sub.includes('CANCELAMENTO') && sub.includes('MATR'))) continue;
  if (shown >= 5) break;
  shown++;
  console.log(`\n--- linha cancelamento #${shown}`);
  console.log('  Protocolo:', d?.Protocolo);
  console.log('  Aluno:', d?.Aluno);
  console.log('  Situação Atendimento:', d?.['Situação Atendimento']);
  console.log('  Situação Deferimento:', d?.['Situação Deferimento']);
  console.log('  Aging Dias:', d?.['Aging Dias']);
  console.log('  Observação:', d?.['Observação']);
  console.log('  Data Previsão:', d?.['Data Previsão']);
  console.log('  Data Conclusão:', d?.['Data Conclusão']);
  console.log('  Data Conclusao (sem acento):', d?.['Data Conclusao']);
  const repaired = repairCaaExportRow(d);
  if (repaired !== d) {
    console.log('  >> APÓS REPAIR ATUAL:');
    console.log('    Protocolo:', repaired?.Protocolo);
    console.log('    Situação Atendimento:', repaired?.['Situação Atendimento']);
  }
}

process.exit(0);
