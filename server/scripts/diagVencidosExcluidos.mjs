/**
 * Por que RGMs da base vencidos não entram na fila remat inadimplente?
 */
import 'dotenv/config';
import * as repo from '../repositories/baseUploadRepository.js';
import {
  buildPersonIndexFromSnapshot,
  buildIdentityLookup,
  collectRowIdentities,
  canonicalFromIdentities,
} from '../services/baseComparisonService.js';
import {
  buildRematriculaConcluidaCanonSet,
  isRematriculaOrigemRow,
  isRematriculaInstituicaoAllowed,
  instituicaoFromRow,
} from '../utils/rematriculaEligibility.js';
import { normalizeCiclo } from '../utils/cicloFromRow.js';

const matSnap = await repo.getLatestSnapshot('matriculados');
const inadSnap = await repo.getLatestSnapshot('inadimplentes-vencidos');
if (!matSnap || !inadSnap) {
  console.log('Snapshots ausentes');
  process.exit(1);
}

const matIndex = await buildPersonIndexFromSnapshot('matriculados', matSnap.id);
const inadIndex = await buildPersonIndexFromSnapshot('inadimplentes-vencidos', inadSnap.id);
const inadLookup = buildIdentityLookup(inadIndex.byCanon);
const concluida = buildRematriculaConcluidaCanonSet(matIndex);

/** canon -> melhor linha 2026/1 em matriculados */
const mat2026ByCanon = new Map();
/** canon -> set ciclos */
const ciclosByCanon = new Map();

await repo.forEachRowDataForSnapshot('matriculados', matSnap.id, (row) => {
  const ids = collectRowIdentities(row, { category: 'matriculados' });
  const canon = canonicalFromIdentities(ids);
  if (!canon) return;
  const ciclo = normalizeCiclo(row.Ciclo ?? '');
  if (!ciclosByCanon.has(canon)) ciclosByCanon.set(canon, new Set());
  if (ciclo) ciclosByCanon.get(canon).add(ciclo);
  if (ciclo === '2026/1') mat2026ByCanon.set(canon, row);
});

const rematInadCanons = new Set();
await repo.forEachRowDataForSnapshot('matriculados', matSnap.id, (row) => {
  if (!isRematriculaOrigemRow(row)) return;
  const ids = collectRowIdentities(row, { category: 'matriculados' });
  const canon = canonicalFromIdentities(ids);
  if (!canon || concluida.has(canon)) return;
  for (const id of ids) {
    if (inadLookup.get(id)?.length) {
      rematInadCanons.add(canon);
      break;
    }
  }
});

const reasons = {
  na_fila: rematInadCanons.size,
  sem_matriculados: 0,
  ja_remat_2026_2: 0,
  sem_linha_2026_1: 0,
  nao_em_curso: 0,
  instituicao_fora: 0,
  outro: 0,
};

const instSamples = {};
const sitSamples = {};

for (const canon of inadIndex.byCanon.keys()) {
  if (rematInadCanons.has(canon)) {
    reasons.na_fila++;
    continue;
  }

  const ciclos = ciclosByCanon.get(canon);
  if (!ciclos) {
    reasons.sem_matriculados++;
    continue;
  }
  if (concluida.has(canon)) {
    reasons.ja_remat_2026_2++;
    continue;
  }

  const row = mat2026ByCanon.get(canon);
  if (!row) {
    reasons.sem_linha_2026_1++;
    continue;
  }

  const sit = String(row['Situação Matrícula'] ?? '').trim().toUpperCase();
  if (sit !== 'EM CURSO') {
    reasons.nao_em_curso++;
    if (sitSamples[sit] == null) sitSamples[sit] = 0;
    sitSamples[sit]++;
    continue;
  }

  if (!isRematriculaInstituicaoAllowed(row)) {
    reasons.instituicao_fora++;
    const inst = instituicaoFromRow(row) || '(vazio)';
    instSamples[inst] = (instSamples[inst] || 0) + 1;
    continue;
  }

  reasons.outro++;
}

console.log('Vencidos snapshot:', inadSnap.row_count, 'canons:', inadIndex.byCanon.size);
console.log('Na fila remat inadimplente:', rematInadCanons.size);
console.log('\nVencidos EXCLUÍDOS da fila (motivo vem do cruzamento com Matriculados):');
const excl = inadIndex.byCanon.size - rematInadCanons.size;
console.log('  Total excluídos:', excl);
for (const [k, v] of Object.entries(reasons)) {
  if (k === 'na_fila') continue;
  console.log(`  ${k}: ${v}`);
}
console.log('\nSituação (excluídos por nao_em_curso):', sitSamples);
console.log('\nInstituição (excluídos por instituicao_fora, top):');
console.log(
  Object.entries(instSamples)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 6)
);
