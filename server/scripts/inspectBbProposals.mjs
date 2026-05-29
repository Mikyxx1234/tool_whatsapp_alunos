import 'dotenv/config';
import { query } from '../db/client.js';

const snap = (await query(
  `select id from acessos_blackboard_snapshots order by created_at desc limit 1`
)).rows[0];
if (!snap) { console.log('sem snapshot'); process.exit(0); }

const rows = (await query(
  `select data from acessos_blackboard_rows where snapshot_id = $1`,
  [snap.id]
)).rows.map(r => r.data || {}).filter(d => d.RGM && d.Aluno);

function clsP1(d) {
  const m = Number(d['Minutos']) || 0;
  const i = Number(d['Interações']) || 0;
  if (m < 10 || i < 5) return 'dormente';
  return 'ativo';
}
function clsP2(d) {
  const m = Number(d['Minutos']) || 0;
  if (m === 0) return 'dormente';
  if (m <= 30) return 'superficial';
  return 'engajado';
}
function clsP3(d) {
  const m = Number(d['Minutos']) || 0;
  const i = Number(d['Interações']) || 0;
  if (m === 0 && i <= 1) return 'nunca';
  if (m === 0 || (m <= 5 && i <= 3)) return 'abriu_so';
  if (m <= 30 || i <= 15) return 'superficial';
  return 'engajado';
}

const propostas = [
  { nome: 'Proposta 1 - 2 níveis (simples)', fn: clsP1 },
  { nome: 'Proposta 2 - 3 níveis (corte por minutos)', fn: clsP2 },
  { nome: 'Proposta 3 - 4 níveis (Minutos x Interações)', fn: clsP3 },
];

for (const p of propostas) {
  const counts = {};
  for (const d of rows) {
    const c = p.fn(d);
    counts[c] = (counts[c] || 0) + 1;
  }
  console.log('\n=== ' + p.nome + ' === (total ' + rows.length + ')');
  for (const [k, v] of Object.entries(counts).sort((a, b) => b[1] - a[1])) {
    console.log('  ' + k.padEnd(15) + ' = ' + String(v).padStart(4) + '  (' + ((v / rows.length) * 100).toFixed(1) + '%)');
  }
}

process.exit(0);
