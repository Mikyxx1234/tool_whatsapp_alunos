/**
 * Importa ZIP SIAA (vários XLSM) para base rematrícula.
 * Uso: node server/scripts/importSiaaZip.mjs [caminho.zip]
 */
import 'dotenv/config';
import fs from 'fs';
import path from 'path';
import { bufferToRowObjectsForUpload } from '../utils/siaaZipImport.js';
import { createSnapshotFromRowObjects } from '../repositories/baseUploadRepository.js';
import { invalidateComparisonCache } from '../services/baseComparisonService.js';
import { invalidateOverviewCache } from '../services/reportOverviewCache.js';
import { invalidateActivationListCache } from '../services/activationService.js';

const defaultZip = path.join(
  process.env.USERPROFILE || '',
  'Downloads',
  'excel__16062026-111255.zip'
);
const zipPath = process.argv[2] || defaultZip;

if (!fs.existsSync(zipPath)) {
  console.error('Arquivo não encontrado:', zipPath);
  process.exit(1);
}

const buf = fs.readFileSync(zipPath);
const fileName = path.basename(zipPath);
console.log(`Importando ${fileName} (${(buf.length / 1024 / 1024).toFixed(1)} MB)…`);

const objects = bufferToRowObjectsForUpload(buf, fileName, { siaaSource: true });
console.log(`Linhas EM CURSO: ${objects.length.toLocaleString('pt-BR')}`);

const result = await createSnapshotFromRowObjects('rematricula', {
  fileName,
  fileSizeBytes: buf.length,
  objects,
  rematriculaSource: 'siaa',
  metadata: { imported_by: 'importSiaaZip.mjs' },
});

console.log('Snapshot:', result.snapshot?.id);
console.log('Row count:', result.rowCount);

invalidateComparisonCache();
invalidateOverviewCache();
invalidateActivationListCache('rematricula');
console.log('Concluído. Cache rematrícula invalidado.');
