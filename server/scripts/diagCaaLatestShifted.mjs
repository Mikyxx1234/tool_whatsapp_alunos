import '../boot-env.js';
import { query } from '../db/client.js';
import { isCaaCancelamentoSolicitacao } from '../utils/caaRowFilters.js';

const { rows: snaps } = await query(
  `select id, file_name, row_count, created_at from processos_caa_snapshots order by created_at desc limit 1`
);
const snap = snaps[0];
if (!snap) { console.log('sem snapshot'); process.exit(0); }
console.log('Snapshot:', snap.file_name, snap.id, snap.row_count, snap.created_at);

const { rows } = await query(
  `select data from processos_caa_rows where snapshot_id = $1`,
  [snap.id]
);

let cancel = 0;
let pendDireto = 0;
let pendEmAging = 0;
let semAmbos = 0;
const exemplos = [];

for (const r of rows) {
  const d = r.data;
  if (!isCaaCancelamentoSolicitacao(d)) continue;
  cancel++;
  const att = String(d?.['Situação Atendimento'] ?? '').toUpperCase();
  const aging = String(d?.['Aging Dias'] ?? '').toUpperCase();
  if (att.includes('PEND')) pendDireto++;
  else if (aging.includes('PEND')) pendEmAging++;
  else semAmbos++;
  if (exemplos.length < 3) {
    exemplos.push({
      Protocolo: d.Protocolo,
      Aluno: d.Aluno,
      'Sit Atend': d['Situação Atendimento'],
      'Sit Defer': d['Situação Deferimento'],
      'Aging Dias': d['Aging Dias'],
      Observação: d.Observação?.toString().slice(0, 80),
      'Data Previsão': d['Data Previsão'],
      'Data Conclusão': d['Data Conclusão'],
    });
  }
}

console.log('\n=== contagens (subprocesso cancelamento) ===');
console.log('  total cancelamento:', cancel);
console.log('  pendente em Situação Atendimento (OK):', pendDireto);
console.log('  pendente escondido em Aging Dias:', pendEmAging);
console.log('  nem pendente nem aging:', semAmbos);
console.log('\n=== 3 amostras ===');
for (const e of exemplos) console.log(JSON.stringify(e, null, 2));
process.exit(0);
