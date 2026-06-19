/**
 * Overlap Excel remat1506 vs fila Rematrícula no painel.
 */
import 'dotenv/config';
import { spawnSync } from 'child_process';
import { writeFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
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

const OUT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '_remat_overlap_report.txt');

function digits(v) {
  return String(v ?? '').replace(/\D/g, '');
}
function normRgm(v) {
  const d = digits(v);
  return d ? d.slice(-8).padStart(8, '0') : '';
}
function normCpf(v) {
  const d = digits(v);
  if (d.length >= 11) return d.slice(-11).padStart(11, '0');
  return d ? d.padStart(11, '0') : '';
}
function personKey(rgm, cpf) {
  const r = normRgm(rgm);
  if (r) return `rgm:${r}`;
  const c = normCpf(cpf);
  return c ? `cpf:${c}` : '';
}

const pyScript = `
import json, re
from openpyxl import load_workbook
path = r"c:\\Users\\Raphael Castro\\Downloads\\remat1506.xlsx"
wb = load_workbook(path, read_only=True, data_only=True)
rows = list(wb["Planilha1"].iter_rows(values_only=True))
wb.close()
headers = [str(h).strip() if h else "" for h in rows[1]]
idx = {h: i for i, h in enumerate(headers) if h}

def digits(v): return re.sub(r"\\D", "", str(v or ""))
def norm_rgm(v):
    d = digits(v); return d[-8:].zfill(8) if d else ""
def norm_cpf(v):
    d = digits(v); return d[-11:].zfill(11) if len(d) >= 11 else (d.zfill(11) if d else "")
def nu(v): return str(v or "").strip().upper()
def em_curso(row):
    return nu(row[idx["SIT_2026_1"]]) == "EM CURSO" and nu(row[idx["SIT_ATUAL"]]) == "EM CURSO"
def fin(row): return nu(row[idx["SIT_FINAN"]])
def key(row):
    rgm = norm_rgm(row[idx["RGM_ALUN"]])
    cpf = norm_cpf(row[idx["CPF_ALUN"]])
    return f"rgm:{rgm}" if rgm else (f"cpf:{cpf}" if cpf else "")

adimpl, inad, all_em = set(), set(), set()
for row in rows[2:]:
    if not em_curso(row): continue
    k = key(row)
    if not k: continue
    all_em.add(k)
    sf = fin(row)
    if sf == "ADIMPLENTE": adimpl.add(k)
    elif sf == "INADIMPLENTE": inad.add(k)
print(json.dumps({"adimpl": list(adimpl), "inad": list(inad), "all_em": list(all_em)}))
`;

const py = spawnSync('python', ['-c', pyScript], { encoding: 'utf-8', maxBuffer: 50 * 1024 * 1024 });
if (py.status !== 0) {
  console.error(py.stderr || py.stdout);
  process.exit(1);
}
const excel = JSON.parse(py.stdout.trim());
const excelAdimpl = new Set(excel.adimpl);
const excelInad = new Set(excel.inad);
const excelAllEm = new Set(excel.all_em);

const matSnap = await repo.getLatestSnapshot('matriculados');
const inadSnap = await repo.getLatestSnapshot('inadimplentes-vencidos');
const matIndex = await buildPersonIndexFromSnapshot('matriculados', matSnap.id);
const inadIndex = await buildPersonIndexFromSnapshot('inadimplentes-vencidos', inadSnap.id);
const inadLookup = buildIdentityLookup(inadIndex.byCanon);
const concluida = buildRematriculaConcluidaCanonSet(matIndex);

/** @type {Map<string, object>} */
const anyMatByKey = new Map();
/** @type {Map<string, { remat_subgrupo: string, row: object }>} */
const panelByKey = new Map();

await repo.forEachRowDataForSnapshot('matriculados', matSnap.id, (row) => {
  const k = personKey(row.RGM ?? row.rgm, row.CPF ?? row.cpf);
  if (k) anyMatByKey.set(k, row);

  if (!isRematriculaOrigemRow(row)) return;
  const ids = collectRowIdentities(row, { category: 'matriculados' });
  const canon = canonicalFromIdentities(ids);
  if (!canon || concluida.has(canon)) return;
  const inadimplente = [...ids].some((id) => inadLookup.get(id)?.length);
  if (k) panelByKey.set(k, { remat_subgrupo: inadimplente ? 'inadimplente' : 'adimplente', row });
});

const panelAdimpl = new Set();
const panelInad = new Set();
for (const [k, v] of panelByKey) {
  if (v.remat_subgrupo === 'adimplente') panelAdimpl.add(k);
  else panelInad.add(k);
}

function overlap(a, b) {
  let n = 0;
  for (const x of a) if (b.has(x)) n++;
  return n;
}
function onlyA(a, b) {
  const out = [];
  for (const x of a) if (!b.has(x)) out.push(x);
  return out;
}

function classifyExcelOnly(keys, segment) {
  const r = {
    no_painel_inadimplente: 0,
    no_painel_adimplente: 0,
    instituicao_fora: 0,
    nao_em_curso_ou_ciclo: 0,
    ja_2026_2: 0,
    sem_matriculados: 0,
    outro: 0,
  };
  const instSamples = {};
  const sitSamples = {};

  for (const key of keys) {
    const panel = panelByKey.get(key);
    if (panel) {
      if (segment === 'adimplente' && panel.remat_subgrupo === 'inadimplente') r.no_painel_inadimplente++;
      else if (segment === 'inadimplente' && panel.remat_subgrupo === 'adimplente') r.no_painel_adimplente++;
      else r.outro++;
      continue;
    }

    const matRow = anyMatByKey.get(key);
    if (!matRow) {
      r.sem_matriculados++;
      continue;
    }
    const canon = canonicalFromIdentities(collectRowIdentities(matRow, { category: 'matriculados' }));
    if (canon && concluida.has(canon)) {
      r.ja_2026_2++;
      continue;
    }
    if (!isRematriculaInstituicaoAllowed(matRow)) {
      r.instituicao_fora++;
      const inst = instituicaoFromRow(matRow);
      instSamples[inst] = (instSamples[inst] || 0) + 1;
      continue;
    }
    const sit = String(matRow['Situação Matrícula'] ?? '').toUpperCase();
    const ciclo = normalizeCiclo(matRow.Ciclo ?? '');
    if (sit !== 'EM CURSO' || ciclo !== '2026/1') {
      r.nao_em_curso_ou_ciclo++;
      sitSamples[`${ciclo}|${sit}`] = (sitSamples[`${ciclo}|${sit}`] || 0) + 1;
      continue;
    }
    r.outro++;
  }
  return { r, instSamples, sitSamples };
}

function classifyPanelOnly(keys, segment) {
  const r = {
    excel_classifica_inadimplente: 0,
    excel_classifica_adimplente: 0,
    excel_fora_dual_em_curso: 0,
    outro: 0,
  };
  for (const key of keys) {
    if (segment === 'adimplente' && excelInad.has(key)) r.excel_classifica_inadimplente++;
    else if (segment === 'inadimplente' && excelAdimpl.has(key)) r.excel_classifica_adimplente++;
    else if (!excelAllEm.has(key)) r.excel_fora_dual_em_curso++;
    else r.outro++;
  }
  return r;
}

const bothAd = overlap(excelAdimpl, panelAdimpl);
const onlyExcelAd = onlyA(excelAdimpl, panelAdimpl);
const onlyPanelAd = onlyA(panelAdimpl, excelAdimpl);

const bothIn = overlap(excelInad, panelInad);
const onlyExcelIn = onlyA(excelInad, panelInad);
const onlyPanelIn = onlyA(panelInad, excelInad);

const adEx = classifyExcelOnly(onlyExcelAd, 'adimplente');
const adPn = classifyPanelOnly(onlyPanelAd, 'adimplente');
const inEx = classifyExcelOnly(onlyExcelIn, 'inadimplente');
const inPn = classifyPanelOnly(onlyPanelIn, 'inadimplente');

const lines = [
  '=== ADIMPLENTE (Excel SIT_FINAN=Adimplente vs Painel not-in-vencidos) ===',
  `Excel: ${excelAdimpl.size} | Painel: ${panelAdimpl.size}`,
  `Em ambos: ${bothAd}`,
  `Só Excel (${onlyExcelAd.length}): ${JSON.stringify(adEx.r)}`,
  `  instituicao_fora amostra: ${JSON.stringify(Object.entries(adEx.instSamples).sort((a,b)=>b[1]-a[1]).slice(0,3))}`,
  `Só Painel (${onlyPanelAd.length}): ${JSON.stringify(adPn)}`,
  '',
  '=== INADIMPLENTE (Excel SIT_FINAN=Inadimplente vs Painel base vencidos) ===',
  `Excel: ${excelInad.size} | Painel: ${panelInad.size}`,
  `Em ambos: ${bothIn}`,
  `Só Excel (${onlyExcelIn.length}): ${JSON.stringify(inEx.r)}`,
  `  instituicao_fora amostra: ${JSON.stringify(Object.entries(inEx.instSamples).sort((a,b)=>b[1]-a[1]).slice(0,3))}`,
  `  nao_em_curso amostra: ${JSON.stringify(Object.entries(inEx.sitSamples).sort((a,b)=>b[1]-a[1]).slice(0,5))}`,
  `Só Painel (${onlyPanelIn.length}): ${JSON.stringify(inPn)}`,
];

const text = lines.join('\n');
writeFileSync(OUT, text, 'utf8');
console.log(text);
