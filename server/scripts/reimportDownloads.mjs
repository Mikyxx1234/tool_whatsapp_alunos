/**
 * Reimporta XLSX da pasta Downloads (após fix cellDates).
 * Uso: node server/scripts/reimportDownloads.mjs
 */
import 'dotenv/config';
import fs from 'fs';
import path from 'path';
import { xlsxBufferToRowObjects } from '../utils/spreadsheetToObjects.js';
import { createSnapshotFromRowObjects } from '../repositories/baseUploadRepository.js';
import { invalidateComparisonCache } from '../services/baseComparisonService.js';
import { invalidateOverviewCache } from '../services/reportOverviewCache.js';
import { invalidateActivationListCache } from '../services/activationService.js';

const home = process.env.USERPROFILE || '';
const downloads = path.join(home, 'Downloads');

const onlyFin = process.argv.includes('--financeiro-only');
const MAP = onlyFin
  ? [['financeiro', 'Alunos com mensalidade em aberto.xlsx']]
  : [
      ['matriculados', 'Relação de matriculados por polo.xlsx'],
      ['docs-pendentes', 'Relação de alunos com documentos pendentes por polo.xlsx'],
      ['financeiro', 'Alunos com mensalidade em aberto.xlsx'],
    ];

for (const [category, fileName] of MAP) {
  const filePath = path.join(downloads, fileName);
  if (!fs.existsSync(filePath)) {
    console.log('skip', category, '(arquivo não encontrado)');
    continue;
  }
  const buf = fs.readFileSync(filePath);
  const objects = xlsxBufferToRowObjects(buf, fileName);
  const result = await createSnapshotFromRowObjects(category, {
    fileName,
    fileSizeBytes: buf.length,
    objects,
    metadata: { reimported_by: 'reimportDownloads.mjs' },
  });
  console.log(category, '→', result.rowCount, 'linhas, snapshot', result.snapshot?.id);
}

invalidateComparisonCache();
invalidateOverviewCache();
for (const [c] of MAP) invalidateActivationListCache(c);
invalidateActivationListCache();

console.log('Concluído. Caches invalidados.');
process.exit(0);
