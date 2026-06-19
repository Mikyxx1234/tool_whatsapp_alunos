/**
 * Repara snapshot Rematrícula já gravado: corrige CPF/RGM em notação científica
 * e preenche RGM ausente via cruzamento com matriculados.
 *
 * Uso: node server/scripts/repairRematriculaSnapshotRgms.mjs [--snapshot-id=uuid]
 */
import 'dotenv/config';
import { query, withTransaction } from '../db/client.js';
import {
  buildPersonIndexFromSnapshot,
  buildIdentityLookup,
  collectRowIdentities,
} from '../services/baseComparisonService.js';
import { repairSiaaRematriculaRow } from '../utils/siaaRematriculaRepair.js';
import {
  displayRgmFromMatriculadosRow,
  displayRgmFromRematriculaRow,
  isValidRematriculaRgm,
  isRgmColumnKey,
} from '../utils/rgmDisplay.js';
import {
  buildMatriculadosRgmMaps,
  rgmFromMatriculadosMaps,
} from '../utils/matriculadosRgmLookup.js';
import {
  cpfDigitsFromExcelCell,
  parseExcelNumericCell,
  phoneDigitsFromExcelCell,
} from '../utils/excelNumericCell.js';
import { invalidateActivationListCache } from '../services/activationService.js';

const NUMERIC_KEYS = new Set([
  'RGM',
  'RGM_ALUN',
  'CPF_ALUN',
  'CPF',
  'FONE_CEL',
  'FONE_COM',
  'FONE_RES',
  'DDD_CEL',
  'DDD_FC',
  'DDD_FR',
]);

/** @param {Record<string, unknown>} row */
function repairStoredNumericFields(row) {
  /** @type {Record<string, unknown>} */
  const out = { ...row };
  for (const [key, val] of Object.entries(row)) {
    const s = String(val ?? '').trim();
    if (!s || !/[eE]/.test(s)) continue;
    if (isRgmColumnKey(key)) {
      out[key] = parseExcelNumericCell(s, { pad: 8, maxDigits: 8 });
    } else if (/cpf/i.test(key)) {
      out[key] = cpfDigitsFromExcelCell(s);
    } else if (/fone|cel|tel|ddd/i.test(key)) {
      out[key] = phoneDigitsFromExcelCell(s);
    } else if (NUMERIC_KEYS.has(key)) {
      out[key] = parseExcelNumericCell(s);
    }
  }
  return out;
}

/** @param {Record<string, unknown>} rematRow @param {Map<string, object[]>|null} matLookup */
function rgmFromMatLookup(rematRow, matLookup) {
  if (!matLookup) return '';
  const ids = collectRowIdentities(rematRow, { category: 'rematricula' });
  for (const id of ids) {
    if (id.startsWith('RGM:')) continue;
    const matches = matLookup.get(id);
    if (!matches?.length) continue;
    for (const matEntry of matches) {
      for (const matId of matEntry.ids) {
        if (matId.startsWith('RGM:')) {
          const canon = matId.slice(4);
          if (isValidRematriculaRgm(canon)) return canon;
        }
      }
      if (matEntry.row) {
        const rgm = displayRgmFromMatriculadosRow(matEntry.row);
        if (isValidRematriculaRgm(rgm)) return rgm;
      }
    }
  }
  return '';
}

const argSnap = process.argv.find((a) => a.startsWith('--snapshot-id='));
let snapshotId = argSnap ? argSnap.split('=')[1] : null;

if (!snapshotId) {
  const snap = await query(
    `SELECT id FROM rematricula_snapshots ORDER BY created_at DESC LIMIT 1`
  );
  snapshotId = snap.rows[0]?.id;
}
if (!snapshotId) {
  console.error('Nenhum snapshot rematrícula.');
  process.exit(1);
}

const matSnap = await query(
  `SELECT id FROM matriculados_snapshots ORDER BY created_at DESC LIMIT 1`
);
let matLookup = null;
/** @type {Awaited<ReturnType<typeof buildMatriculadosRgmMaps>>|null} */
let matMaps = null;
if (matSnap.rows[0]?.id) {
  const matSnapId = matSnap.rows[0].id;
  matLookup = buildIdentityLookup(
    (await buildPersonIndexFromSnapshot('matriculados', matSnapId)).byCanon
  );
  matMaps = await buildMatriculadosRgmMaps(matSnapId);
}

const rows = await query(
  `SELECT id, data FROM rematricula_rows WHERE snapshot_id = $1 ORDER BY row_index`,
  [snapshotId]
);

let fixedNumeric = 0;
let filledFromMat = 0;
let alreadyOk = 0;

await withTransaction(async (client) => {
  for (const { id, data } of rows.rows) {
    let row = repairStoredNumericFields(data);
    row = repairSiaaRematriculaRow(row);
    const hadRgm = displayRgmFromRematriculaRow(data);
    let hasRgm = displayRgmFromRematriculaRow(row);
    if (!hasRgm && matLookup) {
      const fromMat = rgmFromMatLookup(row, matLookup);
      if (fromMat) {
        row.RGM = fromMat;
        row.RGM_ALUN = fromMat;
        hasRgm = fromMat;
        filledFromMat += 1;
      }
    }
    if (!hasRgm && matMaps) {
      const fromMaps = rgmFromMatriculadosMaps(row, matMaps);
      if (fromMaps) {
        row.RGM = fromMaps;
        row.RGM_ALUN = fromMaps;
        hasRgm = fromMaps;
        filledFromMat += 1;
      }
    } else if (hasRgm && !hadRgm && !filledFromMat) {
      fixedNumeric += 1;
    } else if (hasRgm) {
      alreadyOk += 1;
    }
    await client.query(`UPDATE rematricula_rows SET data = $1::jsonb WHERE id = $2`, [
      JSON.stringify(row),
      id,
    ]);
  }
});

invalidateActivationListCache('rematricula');

console.log(`Snapshot ${snapshotId}`);
console.log(`  linhas: ${rows.rows.length}`);
console.log(`  RGM já ok: ${alreadyOk}`);
console.log(`  RGM corrigido (numérico): ${fixedNumeric}`);
console.log(`  RGM preenchido via matriculados: ${filledFromMat}`);
console.log(`  ainda sem RGM: ${
  rows.rows.length - alreadyOk - fixedNumeric - filledFromMat
}`);

process.exit(0);
