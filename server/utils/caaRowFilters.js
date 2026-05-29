/**
 * Linhas da planilha CAA que o time trata como solicitação de cancelamento de matrícula.
 * Critério: coluna Subprocesso (export data.xlsx).
 * @param {Record<string, unknown>} row
 */
export function isCaaCancelamentoSolicitacao(row) {
  const sub = String(row?.Subprocesso ?? row?.subprocesso ?? '').trim();
  if (!sub) return false;
  const lower = sub
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .toLowerCase();
  return lower.includes('cancelamento') && lower.includes('matric');
}

/** Filtro SQL (jsonb `data`) equivalente ao `isCaaCancelamentoSolicitacao`. */
export function caaCancelamentoSqlWhere() {
  return `coalesce(data->>'Subprocesso', '') ilike '%cancelamento%matr%'`;
}

/** @typedef {'open'|'lost_canceled'|'lost_confirmed'|'won_reverted'|'unknown'} CaaStatus */

/**
 * Normaliza par (Situação Atendimento, Situação Deferimento) em status interno.
 *
 *   PENDENTE  + Em aberto   → open           (entra na fila)
 *   CANCELADO + qualquer    → lost_canceled  (aluno desistiu antes do CAA decidir)
 *   CONCLUIDO + Deferido    → lost_confirmed (CAA aprovou o cancelamento)
 *   CONCLUIDO + Indeferido  → won_reverted   (CAA negou — matrícula segue)
 *   resto                   → unknown
 *
 * @param {Record<string, unknown>} row
 * @returns {CaaStatus}
 */
export function normalizeCaaStatus(row) {
  const att = String(row?.['Situação Atendimento'] ?? row?.['Situacao Atendimento'] ?? '')
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .trim()
    .toUpperCase();
  const def = String(row?.['Situação Deferimento'] ?? row?.['Situacao Deferimento'] ?? '')
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .trim()
    .toUpperCase();

  if (att.includes('PEND')) return 'open';
  if (att.includes('CANCEL')) return 'lost_canceled';
  if (def.includes('ABERTO') && !att.includes('CONCLU') && !att.includes('CANCEL')) return 'open';
  if (att.includes('CONCLU')) {
    if (def.includes('INDEFER')) return 'won_reverted';
    if (def.includes('DEFER')) return 'lost_confirmed';
    return 'unknown';
  }
  return 'unknown';
}

/** Linha CAA é cancelamento E está pendente (entra na fila). */
export function isCaaCancelamentoPendente(row) {
  return isCaaCancelamentoSolicitacao(row) && normalizeCaaStatus(row) === 'open';
}

/** SQL para a mesma regra acima sobre coluna jsonb `data`. */
export function caaCancelamentoPendenteSqlWhere() {
  return `${caaCancelamentoSqlWhere()} and (
    coalesce(data->>'Situação Atendimento','') ilike '%PEND%'
    or (
      coalesce(data->>'Situação Deferimento','') ilike '%abert%'
      and coalesce(data->>'Situação Atendimento','') not ilike '%CONCLU%'
      and coalesce(data->>'Situação Atendimento','') not ilike '%CANCEL%'
    )
  )`;
}

/** Rótulo em português para exibição. */
export function caaStatusLabel(status) {
  switch (status) {
    case 'open':
      return 'Pendente — em fila';
    case 'lost_canceled':
      return 'Perdido — aluno desistiu';
    case 'lost_confirmed':
      return 'Perdido — CAA confirmou';
    case 'won_reverted':
      return 'Revertido — CAA negou';
    default:
      return 'Desconhecido';
  }
}
