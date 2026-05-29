import 'dotenv/config';
import * as baseUploadRepo from '../repositories/baseUploadRepository.js';
import { collectRowIdentities } from '../services/baseComparisonService.js';
import { cicloFromRow, normalizeCiclo } from '../utils/cicloFromRow.js';
import { matchMatriculadoToOtherIndex, buildIdentityLookup } from '../services/baseComparisonService.js';
import { buildPersonIndexFromSnapshot } from '../services/baseComparisonService.js';

const matSnap = await baseUploadRepo.getLatestSnapshot('matriculados');
const evSnap = await baseUploadRepo.getLatestSnapshot('provavel-evasao');
console.log('mat', matSnap?.file_name, matSnap?.row_count);
console.log('ev', evSnap?.file_name, evSnap?.row_count);

const matIdx = await buildPersonIndexFromSnapshot('matriculados', matSnap.id);
const evIdx = await buildPersonIndexFromSnapshot('provavel-evasao', evSnap.id);

let aligned = 0;
let cross = 0;
let none = 0;
for (const entry of evIdx.byCanon.values()) {
  const m = matchMatriculadoToOtherIndex(entry, matIdx.byCanon, buildIdentityLookup(matIdx.byCanon));
  if (m === 'aligned') aligned += 1;
  else if (m === 'cross_cycle') cross += 1;
  else none += 1;
}
console.log('ev→mat: aligned', aligned, 'cross_cycle', cross, 'none', none);

// reverse: mat in ev
let ma = 0, mc = 0, mn = 0;
const evLookup = buildIdentityLookup(evIdx.byCanon);
for (const entry of matIdx.byCanon.values()) {
  const m = matchMatriculadoToOtherIndex(entry, evIdx.byCanon, evLookup);
  if (m === 'aligned') ma += 1;
  else if (m === 'cross_cycle') mc += 1;
  else mn += 1;
}
console.log('mat→ev: aligned', ma, 'cross_cycle', mc, 'none', mn);

// sample RGMs
const sampleEv = await baseUploadRepo.fetchAllRowDataForSnapshot('provavel-evasao', evSnap.id);
const sampleMat = [];
let n = 0;
await baseUploadRepo.forEachRowDataForSnapshot('matriculados', matSnap.id, (row) => {
  if (n++ < 5) sampleMat.push(row);
});

console.log('\n--- amostra evasão ---');
for (const r of sampleEv.slice(0, 3)) {
  console.log({
    RGM: r.RGM,
    Ciclo: r.Ciclo,
    cicloNorm: normalizeCiclo(r.Ciclo),
    ids: [...collectRowIdentities(r)],
  });
}
console.log('\n--- amostra matriculados ---');
for (const r of sampleMat) {
  console.log({
    RGM: r.RGM,
    Ciclo: r.Ciclo,
    cicloNorm: normalizeCiclo(r.Ciclo),
    ids: [...collectRowIdentities(r)],
  });
}

// RGM only match ignoring ciclo
const matRgms = new Set();
for (const { ids } of matIdx.byCanon.values()) {
  for (const id of ids) {
    if (id.startsWith('RGM:')) matRgms.add(id);
  }
}
let rgmHit = 0;
for (const { ids } of evIdx.byCanon.values()) {
  for (const id of ids) {
    if (matRgms.has(id)) {
      rgmHit += 1;
      break;
    }
  }
}
console.log('\nmatch só por RGM (ignorando ciclo):', rgmHit, 'de', evIdx.byCanon.size);

// ciclo distribution ev
const evCiclos = new Map();
for (const r of sampleEv) {
  const c = normalizeCiclo(r.Ciclo) || '(vazio)';
  evCiclos.set(c, (evCiclos.get(c) || 0) + 1);
}
const allEv = await baseUploadRepo.fetchAllRowDataForSnapshot('provavel-evasao', evSnap.id);
const evCiclosAll = new Map();
for (const r of allEv) {
  const c = normalizeCiclo(r.Ciclo) || '(vazio)';
  evCiclosAll.set(c, (evCiclosAll.get(c) || 0) + 1);
}
const topEv = [...evCiclosAll.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8);
console.log('\ntop ciclos evasão:', topEv);

const matCiclos = new Map();
await baseUploadRepo.forEachRowDataForSnapshot('matriculados', matSnap.id, (row) => {
  const c = normalizeCiclo(row.Ciclo) || '(vazio)';
  matCiclos.set(c, (matCiclos.get(c) || 0) + 1);
});
const topMat = [...matCiclos.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8);
console.log('top ciclos matriculados:', topMat);

process.exit(0);
