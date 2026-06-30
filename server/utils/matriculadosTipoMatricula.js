import { normalizeCiclo } from './cicloFromRow.js';
import { parseFlexibleDate } from './dateParser.js';

const BRT = 'America/Sao_Paulo';

/** Rematrícula: só Graduação EAD (código 12). Pós (7) e UCS-CL (79) ficam fora. */
export function isMatriculadosEmpresaAllowed(row) {
  const emp = String(row?.empresa ?? row?.Empresa ?? '').trim();
  return /^12 -/.test(emp);
}

/** Graduação EAD (12) + Pós UCS (7) — mesmo escopo do Dashboard Acadêmico geral. */
export function isMatriculadosDashboardEmpresa(row) {
  const emp = String(row?.empresa ?? row?.Empresa ?? '').trim();
  return /^(12|7) -/.test(emp);
}

/** Situação acadêmica no snapshot de matriculados. */
export function situacaoMatriculaFromRow(row) {
  if (!row || typeof row !== 'object') return '';
  return String(
    row.situacao ??
      row.Situacao ??
      row['Situação'] ??
      row['Situação Matrícula'] ??
      row['Situacao Matricula'] ??
      ''
  ).trim();
}

/** @returns {boolean} */
export function isMatriculadosEmCurso(row) {
  return stripAccentsLower(situacaoMatriculaFromRow(row)) === 'em curso';
}

/** Fila de ativação por turma: EM CURSO + Graduação EAD (12). */
export function isMatriculadosActivationEligible(row) {
  return isMatriculadosEmpresaAllowed(row) && isMatriculadosEmCurso(row);
}

/** Ciclo só da coluna ciclo, formato YYYY/N — igual ao snapshot do CRM. */
export function cicloMatriculaFromSnapshotRow(row) {
  const raw = String(row?.ciclo ?? row?.Ciclo ?? '').trim();
  if (!/^\d{4}\/\d$/.test(raw)) return '';
  return normalizeCiclo(raw);
}

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
  if (!isMatriculadosEmpresaAllowed(row)) return false;
  if (classifyTipoMatricula(tipoMatriculaFromRow(row)) !== 'rematricula') return false;
  if (cicloDestinoNorm) {
    const ciclo = cicloMatriculaFromSnapshotRow(row);
    if (ciclo !== cicloDestinoNorm) return false;
  }
  return true;
}
