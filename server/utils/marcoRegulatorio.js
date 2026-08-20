/**
 * Marco regulatório (grade curricular) a partir da lista 2025/2.
 *
 * Pré = RGM da base matriculados_25.2.xlsx:
 *   - VETERANO: todos
 *   - INGRESSANTE com Data Matrícula ≤ 2025-09-13
 * Quem está nessa lista e ainda no SIAA atual → Pré. O resto → Pós.
 * Sem RGM → não grava. Match só por RGM (Retorno com RGM novo não herda Pré do CPF).
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  classifyTipoMatricula,
  tipoMatriculaFromRow,
} from './matriculadosTipoMatricula.js';
import { normalizeRgm } from './novoCrmCacheNormalize.js';

const DATA_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'data');
const CONFIG_PATH = path.join(DATA_DIR, 'marco-regulatorio.json');

const DEFAULTS = {
  cutoff: '2025-09-13',
  labels: { pre: 'Pré', pos: 'Pós' },
  preListFile: 'marco-pre-rgms.json',
};

let cachedCfg;
let cachedList;

export function loadMarcoRegulatorioConfig() {
  if (cachedCfg) return cachedCfg;
  let file = {};
  try {
    file = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
  } catch {
    file = {};
  }
  cachedCfg = {
    ...DEFAULTS,
    ...file,
    labels: { ...DEFAULTS.labels, ...(file.labels || {}) },
  };
  return cachedCfg;
}

function loadPreList() {
  if (cachedList) return cachedList;
  const cfg = loadMarcoRegulatorioConfig();
  const listPath = path.join(DATA_DIR, cfg.preListFile || DEFAULTS.preListFile);
  let file = { rgms: [] };
  try {
    file = JSON.parse(fs.readFileSync(listPath, 'utf8'));
  } catch {
    file = { rgms: [] };
  }
  cachedList = {
    rgms: new Set((file.rgms || []).map((x) => normalizeRgm(x)).filter(Boolean)),
  };
  return cachedList;
}

/** Só testes / reload após editar o JSON. */
export function resetMarcoRegulatorioConfigCache() {
  cachedCfg = undefined;
  cachedList = undefined;
}

function rgmFromRow(row) {
  if (!row || typeof row !== 'object') return '';
  return normalizeRgm(
    row.RGM ??
      row.rgm ??
      row.Rgm ??
      row.RGM_ALUN ??
      row.RGM_ALUNO ??
      row['RGM Aluno'] ??
      row['RGM ALUNO'] ??
      ''
  );
}

export function rgmNumericFromRow(row) {
  const rgm = rgmFromRow(row);
  if (!rgm) return null;
  const n = Number(rgm);
  return Number.isSafeInteger(n) && n > 0 ? n : null;
}

/**
 * @param {Record<string, unknown>} row linha do snapshot matriculados
 * @returns {{ value: 'pre'|'pos'|null, label: string|null, reason: string, tipo: string, rgm: number|null }}
 */
export function classifyMarcoRegulatorio(row) {
  const cfg = loadMarcoRegulatorioConfig();
  const list = loadPreList();
  const tipo = classifyTipoMatricula(tipoMatriculaFromRow(row));
  const rgm = rgmNumericFromRow(row);
  const rgmStr = rgmFromRow(row);
  const base = { tipo, rgm };

  if (!rgmStr) {
    return { ...base, value: null, label: null, reason: 'sem_rgm' };
  }
  if (list.rgms.has(rgmStr)) {
    return { ...base, value: 'pre', label: cfg.labels.pre, reason: 'lista_2025_2' };
  }
  return { ...base, value: 'pos', label: cfg.labels.pos, reason: 'fora_lista_2025_2' };
}

/** Par {fieldId,value} para PUT, ou null se campo ausente / classificação vazia. */
export function marcoFieldPair(fieldIds, row) {
  const fieldId = String(fieldIds?.marco || '').trim();
  if (!fieldId) return null;
  const label = classifyMarcoRegulatorio(row).label;
  if (!label) return null;
  return { fieldId, value: label };
}
