import { normalizePersonName } from './personName.js';
import {
  normalizeRgmCanonical,
  isLikelyErpMatriculaRgm,
  displayRgmFromMatriculadosRow,
} from './rgmDisplay.js';
import { cpfDigitsFromExcelCell } from './excelNumericCell.js';
import * as baseUploadRepo from '../repositories/baseUploadRepository.js';

/**
 * Índices diretos matriculados → RGM (2ª verificação quando identidade/index falha).
 * @typedef {{ byCpf: Map<string, string>, byEmail: Map<string, string>, byNome: Map<string, string> }}
 */

/**
 * @param {string} snapshotId
 * @returns {Promise<MatriculadosRgmMaps>}
 */
export async function buildMatriculadosRgmMaps(snapshotId) {
  /** @type {MatriculadosRgmMaps} */
  const maps = {
    byCpf: new Map(),
    byEmail: new Map(),
    byNome: new Map(),
  };

  await baseUploadRepo.forEachRowDataForSnapshot('matriculados', snapshotId, (row) => {
    const rgm = displayRgmFromMatriculadosRow(row);
    if (!/^\d{8}$/.test(rgm)) return;

    const cpf = cpfDigitsFromExcelCell(row.CPF ?? row.Cpf ?? row.cpf ?? '');
    if (cpf.length === 11) maps.byCpf.set(cpf, rgm);

    const email = String(row.Email ?? row['E-mail'] ?? row.E_MAIL ?? row.email ?? '')
      .trim()
      .toLowerCase();
    if (email.length >= 6 && email.includes('@') && email.includes('.')) {
      maps.byEmail.set(email, rgm);
    }

    const nome = normalizePersonName(row.Nome ?? row.Aluno ?? row.NOME ?? row.nome ?? '');
    if (nome.length >= 8) maps.byNome.set(nome, rgm);
  });

  return maps;
}

/**
 * Dupla verificação: CPF → e-mail → nome normalizado.
 * @param {Record<string, unknown>} rematRow
 * @param {MatriculadosRgmMaps|null} maps
 */
export function rgmFromMatriculadosMaps(rematRow, maps) {
  if (!maps || !rematRow) return '';

  const cpf = cpfDigitsFromExcelCell(rematRow.CPF_ALUN ?? rematRow.CPF ?? '');
  if (cpf.length === 11) {
    const hit = maps.byCpf.get(cpf);
    if (hit) return hit;
  }

  const email = String(rematRow.E_MAIL ?? rematRow.Email ?? rematRow['E-mail'] ?? '')
    .trim()
    .toLowerCase();
  if (email.length >= 6 && email.includes('@')) {
    const hit = maps.byEmail.get(email);
    if (hit) return hit;
  }

  const nome = normalizePersonName(rematRow.NOME ?? rematRow.Nome ?? rematRow.Aluno ?? rematRow.nome ?? '');
  if (nome.length >= 8) {
    const hit = maps.byNome.get(nome);
    if (hit) return hit;
  }

  return '';
}
