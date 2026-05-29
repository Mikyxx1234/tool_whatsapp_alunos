import 'dotenv/config';
import * as baseUploadRepo from '../repositories/baseUploadRepository.js';
import {
  buildPersonIndexFromSnapshot,
  buildIdentityLookup,
  matchMatriculadoToOtherIndex,
} from '../services/baseComparisonService.js';

const matSnap = await baseUploadRepo.getLatestSnapshot('matriculados');
const evSnap = await baseUploadRepo.getLatestSnapshot('provavel-evasao');
const matIdx = await buildPersonIndexFromSnapshot('matriculados', matSnap.id);
const evIdx = await buildPersonIndexFromSnapshot('provavel-evasao', evSnap.id);
const matLookup = buildIdentityLookup(matIdx.byCanon);

let aligned = 0,
  cross = 0,
  none = 0;
for (const entry of evIdx.byCanon.values()) {
  const m = matchMatriculadoToOtherIndex(entry, matIdx.byCanon, matLookup);
  if (m === 'aligned') aligned += 1;
  else if (m === 'cross_cycle') cross += 1;
  else none += 1;
}
console.log('ev pessoas', evIdx.byCanon.size, '→ mat aligned', aligned, 'cross', cross, 'none', none);

process.exit(0);
