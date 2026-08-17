/**
 * Marco regulatório (grade curricular) a partir da linha do snapshot SIAA diário.
 *
 * O arquivo diário não traz código de curso (1 vs 493). Data Matrícula na
 * REMATRICULA é a remat do ciclo, não o ingresso — não serve de corte.
 *
 * Regras (data/marco-regulatorio.json):
 *   NOVA MATRICULA / RECOMPRA → Data Matrícula < cutoff → Pré; senão Pós
 *   REMATRICULA / RETORNO → série ≤ 2 Pós; série ≥ 4 Pré; série 3 = Pré
 *     (RGM da série 3 é era antiga; 2025/2 não tem código no diário)
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { toIsoDate } from './dateParser.js';
import {
  classifyTipoMatricula,
  tipoMatriculaFromRow,
} from './matriculadosTipoMatricula.js';

const CONFIG_PATH = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  'data',
  'marco-regulatorio.json'
);

const DEFAULTS = {
  cutoff: '2025-09-15',
  labels: { pre: 'Pré', pos: 'Pós' },
  retornoForcesPre: false,
  dateBasedTipos: ['novos', 'recompra'],
  rematricula: { posMaxSerie: 2, preMinSerie: 4, serie3: 'pre' },
};

let cached;

export function loadMarcoRegulatorioConfig() {
  if (cached) return cached;
  let file = {};
  try {
    file = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
  } catch {
    file = {};
  }
  const remat = { ...DEFAULTS.rematricula, ...(file.rematricula || {}) };
  cached = {
    ...DEFAULTS,
    ...file,
    labels: { ...DEFAULTS.labels, ...(file.labels || {}) },
    dateBasedTipos: Array.isArray(file.dateBasedTipos)
      ? file.dateBasedTipos
      : DEFAULTS.dateBasedTipos,
    rematricula: remat,
  };
  return cached;
}

/** Só testes / reload após editar o JSON. */
export function resetMarcoRegulatorioConfigCache() {
  cached = undefined;
}

export function serieFromRow(row) {
  if (!row || typeof row !== 'object') return null;
  const raw =
    row.serie ??
    row.Serie ??
    row.Série ??
    row['Série'] ??
    row['Serie'] ??
    row.SERIE ??
    row['Série/Período'] ??
    '';
  const s = String(raw).trim();
  if (!s) return null;
  // Upload SIAA: serial Excel 1..N vira data US "1/3/00" / "1/10/00".
  const excelLeak = s.match(/^1\/(\d{1,2})\/(?:00|1900)$/);
  if (excelLeak) {
    const n = Number(excelLeak[1]);
    return Number.isInteger(n) && n > 0 ? n : null;
  }
  const m = s.match(/(\d+)/);
  if (!m) return null;
  const n = Number(m[1]);
  return Number.isInteger(n) && n > 0 ? n : null;
}

function dataMatriculaIso(row) {
  if (!row || typeof row !== 'object') return '';
  const raw =
    row.data_mat ??
    row['Data Mat'] ??
    row['Data Matrícula'] ??
    row['Data matrícula'] ??
    row.data_matricula ??
    row['Data Matricula'] ??
    row['Data da Matricula'] ??
    row['Data de Matrícula'] ??
    '';
  return toIsoDate(raw) || '';
}

function byDate(row, cfg) {
  const key = dataMatriculaIso(row);
  if (!key) return { value: null, label: null, reason: 'sem_data' };
  if (key < cfg.cutoff) {
    return { value: 'pre', label: cfg.labels.pre, reason: 'data_antes_marco' };
  }
  return { value: 'pos', label: cfg.labels.pos, reason: 'data_desde_marco' };
}

function bySerieRemat(serie, cfg) {
  const remat = cfg.rematricula;
  if (serie == null) return { value: null, label: null, reason: 'remat_sem_serie' };
  if (serie <= remat.posMaxSerie) {
    return { value: 'pos', label: cfg.labels.pos, reason: 'remat_serie_pos' };
  }
  if (serie >= remat.preMinSerie) {
    return { value: 'pre', label: cfg.labels.pre, reason: 'remat_serie_pre' };
  }
  const s3 = String(remat.serie3 || 'indefinido').toLowerCase();
  if (s3 === 'pre') {
    return { value: 'pre', label: cfg.labels.pre, reason: 'remat_serie3_pre' };
  }
  if (s3 === 'pos' || s3 === 'pós') {
    return { value: 'pos', label: cfg.labels.pos, reason: 'remat_serie3_pos' };
  }
  return { value: null, label: null, reason: 'remat_serie3_indefinido' };
}

/**
 * @param {Record<string, unknown>} row linha do snapshot matriculados
 * @returns {{ value: 'pre'|'pos'|null, label: string|null, reason: string, tipo: string, serie: number|null }}
 */
export function classifyMarcoRegulatorio(row) {
  const cfg = loadMarcoRegulatorioConfig();
  const tipo = classifyTipoMatricula(tipoMatriculaFromRow(row));
  const serie = serieFromRow(row);
  const base = { tipo, serie };

  if (cfg.retornoForcesPre && tipo === 'regresso') {
    return { ...base, value: 'pre', label: cfg.labels.pre, reason: 'retorno' };
  }
  if ((cfg.dateBasedTipos || []).includes(tipo)) {
    return { ...base, ...byDate(row, cfg) };
  }
  if (tipo === 'rematricula' || tipo === 'regresso') {
    if (serie == null && tipo === 'regresso') {
      const dated = byDate(row, cfg);
      return { ...base, ...dated, reason: `retorno_${dated.reason}` };
    }
    const bySerie = bySerieRemat(serie, cfg);
    return {
      ...base,
      ...bySerie,
      reason: tipo === 'regresso' ? `retorno_${bySerie.reason}` : bySerie.reason,
    };
  }
  return { ...base, value: null, label: null, reason: 'tipo_indefinido' };
}

/** Par {fieldId,value} para PUT, ou null se campo ausente / classificação vazia. */
export function marcoFieldPair(fieldIds, row) {
  const fieldId = String(fieldIds?.marco || '').trim();
  if (!fieldId) return null;
  const label = classifyMarcoRegulatorio(row).label;
  if (!label) return null;
  return { fieldId, value: label };
}
