/**
 * Auditoria de telefones no snapshot rematrícula mais recente.
 * Uso: node server/scripts/auditRematriculaPhones.mjs
 */
import 'dotenv/config';
import { query } from '../db/client.js';
import { repairSiaaRematriculaRow } from '../utils/siaaRematriculaRepair.js';
import { sanitizeContactPhone } from '../utils/datacrazySearchTerm.js';

const { rows: snaps } = await query(
  `select id, created_at, row_count
     from rematricula_snapshots
    order by created_at desc
    limit 1`
);

if (!snaps.length) {
  console.log('Nenhum snapshot rematrícula encontrado.');
  process.exit(0);
}

const snap = snaps[0];
console.log(`Snapshot: ${snap.id} (${snap.row_count} linhas, ${snap.created_at})`);

const { rows } = await query(
  `select data from rematricula_rows where snapshot_id = $1`,
  [snap.id]
);

let withValidPhone = 0;
let withCpf = 0;
let withEmail = 0;
let withLookupKey = 0;
let placeholderRaw = 0;
let shortGarbage = 0;
let repairedEmpty = 0;

for (const { data } of rows) {
  const rawFone = String(data.FONE_CEL ?? data.TELEFONE_CEL ?? '');
  const rawDdd = String(data.DDD_CEL ?? '');
  if (/encontrado|55\s*n/i.test(rawFone + rawDdd)) placeholderRaw += 1;

  const repaired = repairSiaaRematriculaRow(data);
  const tel = sanitizeContactPhone(repaired.FONE_CEL);
  if (tel) withValidPhone += 1;
  else repairedEmpty += 1;

  const cpf = String(repaired.CPF ?? repaired.CPF_ALUN ?? '').replace(/\D/g, '');
  if (cpf.length === 11) withCpf += 1;

  const email = String(repaired.E_MAIL ?? '').trim();
  if (email.includes('@')) withEmail += 1;

  if (tel || cpf.length === 11 || email.includes('@')) withLookupKey += 1;

  const merged = String(repaired.FONE_CEL ?? '');
  if (merged && merged.length < 10) shortGarbage += 1;
}

const total = rows.length;
const pct = (n) => ((n / total) * 100).toFixed(1);

console.log('\n--- Telefones (pós-repair) ---');
console.log(`Válidos (10-11 dígitos): ${withValidPhone} (${pct(withValidPhone)}%)`);
console.log(`Sem telefone utilizável: ${repairedEmpty} (${pct(repairedEmpty)}%)`);
console.log(`Com CPF: ${withCpf} (${pct(withCpf)}%)`);
console.log(`Com e-mail: ${withEmail} (${pct(withEmail)}%)`);
console.log(`Com CPF ou e-mail (lookup possível): ${withLookupKey} (${pct(withLookupKey)}%)`);

console.log('\n--- Lixo no JSON bruto (antes do repair na UI) ---');
console.log(`Linhas com "encontrado"/55n no DDD ou FONE: ${placeholderRaw}`);
console.log(`FONE_CEL curto (<10 dígitos) após repair: ${shortGarbage}`);

process.exit(0);
