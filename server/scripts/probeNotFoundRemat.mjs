import 'dotenv/config';
import fs from 'fs';
import { datacrazyClient } from '../services/datacrazyClient.js';

function parseCsvLine(line) {
  const out = [];
  let cur = '';
  let q = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === '"') {
      q = !q;
      continue;
    }
    if (c === ',' && !q) {
      out.push(cur);
      cur = '';
      continue;
    }
    cur += c;
  }
  out.push(cur);
  return out;
}

async function searchTerm(term) {
  try {
    const page = await datacrazyClient.searchLeads({ search: term, take: 5 });
    return page.data || [];
  } catch (err) {
    return { error: err.message };
  }
}

const path = process.argv[2];
const lines = fs.readFileSync(path, 'utf8').trim().split(/\r?\n/);
const header = parseCsvLine(lines[0]);
const rows = lines.slice(1).map((l) => {
  const p = parseCsvLine(l);
  const o = {};
  header.forEach((h, i) => {
    o[h] = p[i] || '';
  });
  return o;
});

let foundEmail = 0;
let foundCpf = 0;
let foundCpfPadded = 0;
let foundNeither = 0;

for (const r of rows) {
  const cpf = r.cpf.replace(/\D/g, '');
  const cpfPadded = cpf.length === 10 ? cpf.padStart(11, '0') : cpf;
  const email = r.email.trim().toLowerCase();

  const byEmail = await searchTerm(email);
  const emailHit =
    Array.isArray(byEmail) &&
    byEmail.some((l) => String(l.email || '').trim().toLowerCase() === email);

  let cpfHit = false;
  if (cpf.length === 11) {
    const byCpf = await searchTerm(cpf);
    cpfHit =
      Array.isArray(byCpf) &&
      byCpf.some((l) => String(l.taxId || '').replace(/\D/g, '') === cpf);
  }

  let paddedHit = false;
  if (cpf.length === 10) {
    const byPad = await searchTerm(cpfPadded);
    paddedHit =
      Array.isArray(byPad) &&
      byPad.some((l) => String(l.taxId || '').replace(/\D/g, '') === cpfPadded);
  }

  const status = emailHit
    ? 'EMAIL'
    : cpfHit
      ? 'CPF'
      : paddedHit
        ? 'CPF_PAD'
        : 'NONE';
  if (status === 'EMAIL') foundEmail++;
  else if (status === 'CPF') foundCpf++;
  else if (status === 'CPF_PAD') foundCpfPadded++;
  else foundNeither++;

  console.log(
    [status.padEnd(8), r.rgm, cpf.padEnd(11), email.slice(0, 35), r.nome.slice(0, 30)].join(' | ')
  );
  await new Promise((r) => setTimeout(r, 200));
}

console.log('\n---');
console.log('por email', foundEmail);
console.log('por cpf 11', foundCpf);
console.log('por cpf pad', foundCpfPadded);
console.log('nenhum', foundNeither);
