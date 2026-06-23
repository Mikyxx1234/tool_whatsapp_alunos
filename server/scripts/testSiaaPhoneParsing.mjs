/**
 * Valida parsing de telefone SIAA (import + activation).
 * Uso: node server/scripts/testSiaaPhoneParsing.mjs
 */
import { parseExcelNumericCell, phoneDigitsFromExcelCell } from '../utils/excelNumericCell.js';
import { repairSiaaRematriculaRow, buildSiaaCelularFromDddAndFone } from '../utils/siaaRematriculaRepair.js';
import { sanitizeContactPhone, isPlaceholderContact } from '../utils/datacrazySearchTerm.js';

/** @type {[string, Record<string, unknown>, string, string][]} */
const CASES = [
  ['sci notation fone', { DDD_CEL: '11', FONE_CEL: '9.87654321E8' }, '11987654321', '11987654321'],
  ['sci notation ddd', { DDD_CEL: '1.1E1', FONE_CEL: '987654321' }, '11987654321', '11987654321'],
  ['8-digit legacy', { DDD_CEL: '21', FONE_CEL: '87654321' }, '21987654321', '21987654321'],
  ['fone already with ddd', { DDD_CEL: '11', FONE_CEL: '11987654321' }, '11987654321', '11987654321'],
  ['placeholder fone only', { DDD_CEL: '11', FONE_CEL: '55n encontrado' }, '', ''],
  ['placeholder ddd + real fone', { DDD_CEL: '55n encontrado', FONE_CEL: '987654321' }, '', ''],
  ['nao encontrado long form', { DDD_CEL: '11', FONE_CEL: '55 não encontrado' }, '', ''],
  ['empty ddd, full fone', { DDD_CEL: '', FONE_CEL: '11987654321' }, '11987654321', '11987654321'],
  ['12 digits with 55 prefix', { DDD_CEL: '', FONE_CEL: '5511987654321' }, '11987654321', '11987654321'],
  ['only ddd placeholder', { DDD_CEL: '55n encontrado', FONE_CEL: '' }, '', ''],
];

let failed = 0;
for (const [label, row, expSnap, expAct] of CASES) {
  const repaired = repairSiaaRematriculaRow({ ...row });
  const snapFone = String(repaired.FONE_CEL ?? '');
  const actTel = sanitizeContactPhone(snapFone);
  const ok = snapFone === expSnap && actTel === expAct;
  console.log(`${ok ? 'OK' : 'FAIL'} ${label}`);
  if (!ok) {
    failed += 1;
    console.log('  row:', row);
    console.log('  snapshot FONE_CEL:', snapFone, 'expected:', expSnap);
    console.log('  activation telefone:', actTel, 'expected:', expAct);
    console.log('  merge raw:', buildSiaaCelularFromDddAndFone(row));
    console.log('  isPlaceholder DDD:', isPlaceholderContact(row.DDD_CEL));
    console.log('  isPlaceholder FONE:', isPlaceholderContact(row.FONE_CEL));
  }
}

const UNIT = [
  ['parseExcelNumericCell 9,43E+08', () => parseExcelNumericCell('9,43E+08'), '943000000'],
  ['phoneDigits 55n encontrado', () => phoneDigitsFromExcelCell('55n encontrado'), '55'],
  ['sanitize rejects placeholder', () => sanitizeContactPhone('55n encontrado'), ''],
];
for (const [label, fn, exp] of UNIT) {
  const got = fn();
  const ok = got === exp;
  console.log(`${ok ? 'OK' : 'FAIL'} ${label}:`, got);
  if (!ok) failed += 1;
}

console.log(failed ? `\n${failed} failure(s)` : '\nAll passed');
process.exit(failed ? 1 : 0);
