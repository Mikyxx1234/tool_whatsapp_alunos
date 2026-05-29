import 'dotenv/config';
import { query } from '../db/client.js';

const snap = (await query(
  `select id, file_name, row_count from acessos_blackboard_snapshots
     order by created_at desc limit 1`
)).rows[0];
if (!snap) { console.log('sem snapshot BB'); process.exit(0); }

const rows = (await query(
  `select data from acessos_blackboard_rows where snapshot_id = $1`,
  [snap.id]
)).rows;

console.log('snapshot:', snap.file_name, '| linhas:', rows.length);

const minutosBuckets = { '0': 0, '1-10': 0, '11-60': 0, '61-300': 0, '>300': 0 };
const interBuckets = { '0': 0, '1-5': 0, '6-20': 0, '21-100': 0, '>100': 0 };
const ultimoBuckets = { vazio: 0, '<=7d': 0, '8-15d': 0, '16-30d': 0, '31-60d': 0, '>60d': 0 };

function excelSerialToDate(serial) {
  if (typeof serial !== 'number') return null;
  return new Date(Math.round((serial - 25569) * 86400 * 1000));
}

const today = Date.now();
for (const r of rows) {
  const d = r.data || {};
  const min = Number(d['Minutos']) || 0;
  if (min === 0) minutosBuckets['0']++;
  else if (min <= 10) minutosBuckets['1-10']++;
  else if (min <= 60) minutosBuckets['11-60']++;
  else if (min <= 300) minutosBuckets['61-300']++;
  else minutosBuckets['>300']++;

  const inter = Number(d['Interações']) || 0;
  if (inter === 0) interBuckets['0']++;
  else if (inter <= 5) interBuckets['1-5']++;
  else if (inter <= 20) interBuckets['6-20']++;
  else if (inter <= 100) interBuckets['21-100']++;
  else interBuckets['>100']++;

  const ua = d['Ultimo Acesso'];
  if (!ua || ua === '' || ua === '-' || String(ua).toLowerCase().includes('nunca')) {
    ultimoBuckets.vazio++;
  } else {
    const n = Number(ua);
    let date = Number.isFinite(n) ? excelSerialToDate(n) : null;
    if (!date) date = new Date(String(ua));
    if (!date || Number.isNaN(date.getTime())) {
      ultimoBuckets.vazio++;
    } else {
      const days = Math.floor((today - date.getTime()) / 86400000);
      if (days <= 7) ultimoBuckets['<=7d']++;
      else if (days <= 15) ultimoBuckets['8-15d']++;
      else if (days <= 30) ultimoBuckets['16-30d']++;
      else if (days <= 60) ultimoBuckets['31-60d']++;
      else ultimoBuckets['>60d']++;
    }
  }
}

console.log('\nMinutos:', JSON.stringify(minutosBuckets));
console.log('Interações:', JSON.stringify(interBuckets));
console.log('Último Acesso (idade):', JSON.stringify(ultimoBuckets));

console.log('\n=== exemplos de cada bucket de Último Acesso ===');
const seen = {};
for (const r of rows) {
  const d = r.data || {};
  const ua = d['Ultimo Acesso'];
  let bucket = 'vazio';
  if (ua && ua !== '' && ua !== '-') {
    const n = Number(ua);
    const date = Number.isFinite(n) ? excelSerialToDate(n) : new Date(String(ua));
    if (date && !Number.isNaN(date.getTime())) {
      const days = Math.floor((today - date.getTime()) / 86400000);
      if (days <= 7) bucket = '<=7d';
      else if (days <= 15) bucket = '8-15d';
      else if (days <= 30) bucket = '16-30d';
      else if (days <= 60) bucket = '31-60d';
      else bucket = '>60d';
    }
  }
  if (!seen[bucket]) {
    seen[bucket] = true;
    console.log(`[${bucket}] RGM=${d.RGM} | Aluno=${d.Aluno} | UltimoAcesso=${ua} | Minutos=${d.Minutos} | Interações=${d['Interações']}`);
  }
}

process.exit(0);
