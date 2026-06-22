import { cicloFromRow, normalizeCiclo } from './cicloFromRow.js';
import { parseFlexibleDate } from './dateParser.js';

const BRT = 'America/Sao_Paulo';

function stripAccentsLower(s) {
  return String(s || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase();
}

/** Mesma regra do Dashboard Acadêmico (dcz routes/dashboard.py). */
export function classifyTipoMatricula(raw) {
  const v = String(raw ?? '').trim();
  if (!v || v === 'Não informado' || v === 'N/I') return 'outros';
  const s = stripAccentsLower(v);
  if (s.includes('remat') || s.includes('renovacao') || s.includes('veterano')) return 'rematricula';
  if (s.includes('regresso') || s.includes('retorno')) return 'regresso';
  if (s.includes('recompra')) return 'recompra';
  if (s.includes('matricula') || s.includes('calouro')) return 'novos';
  return 'outros';
}

export function tipoMatriculaFromRow(row) {
  if (!row || typeof row !== 'object') return '';
  return String(
    row.tipo_matricula ??
      row['Tipo Matricula'] ??
      row['Tipo Matrícula'] ??
      row['Tipo matricula'] ??
      row.Tipo ??
      ''
  ).trim();
}

export function dataMatriculaDateKey(row) {
  const raw =
    row?.data_mat ??
    row?.['Data Mat'] ??
    row?.['Data matrícula'] ??
    row?.data_matricula ??
    row?.['Data Matricula'] ??
    '';
  const d = parseFlexibleDate(raw);
  if (!d) return null;
  return d.toLocaleDateString('en-CA', { timeZone: BRT });
}

/** @returns {boolean} */
export function isMatriculadosRematriculaRow(row, cicloDestinoNorm) {
  if (classifyTipoMatricula(tipoMatriculaFromRow(row)) !== 'rematricula') return false;
  if (cicloDestinoNorm) {
    const ciclo = normalizeCiclo(cicloFromRow(row));
    if (ciclo !== cicloDestinoNorm) return false;
  }
  return true;
}
