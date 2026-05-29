/**
 * Corrige export CAA com colunas deslocadas.
 *
 * V1: Protocolo vira "0", status vai para Observação / Data Conclusão.
 * V2: Protocolo recebe bloco de motivo/texto, status vai para Aging Dias,
 *     protocolo real fica em Data Previsão, email fica em Situação Deferimento.
 */

function normKey(s) {
  return String(s ?? '')
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .trim()
    .toUpperCase();
}

function looksLikeProtocol(v) {
  const d = String(v ?? '').replace(/\D/g, '');
  return d.length >= 9 && d.length <= 12;
}

function looksLikeAtendimentoStatus(v) {
  const a = normKey(v);
  if (!a) return false;
  return (
    a.includes('PEND') ||
    a.includes('CANCEL') ||
    a.includes('CONCLU') ||
    a === 'EM ABERTO'
  );
}

function looksLikeDeferimentoStatus(v) {
  const d = normKey(v);
  if (!d) return false;
  return d.includes('DEFER') || d.includes('INDEFER') || d.includes('ABERTO');
}

function looksLikePhone(v) {
  const d = String(v ?? '').replace(/\D/g, '');
  return d.length >= 10 && d.length <= 13;
}

// ---------------------------------------------------------------------------
// V2 detection & repair
// ---------------------------------------------------------------------------

/**
 * Detecta padrão V2: Protocolo recebe bloco de texto (Motivo/Submotivo),
 * status real está em Aging Dias, protocolo real está em Data Previsão.
 * @param {Record<string, unknown>} row
 */
function looksLikeMisalignedV2(row) {
  const prot = String(row.Protocolo ?? row.protocolo ?? '');
  const agingRaw = String(row['Aging Dias'] ?? '').trim();
  const prevRaw = String(row['Data Previsão'] ?? row['Data Previsao'] ?? '').trim();

  // Sinal mais forte: campo Protocolo contém texto de motivo
  const protHasMotivo = prot.includes('Motivo:') || prot.includes('Submotivo:');

  // Aging Dias carrega o status real
  const agingIsStatus = looksLikeAtendimentoStatus(agingRaw);

  // Data Previsão carrega o número de protocolo
  const prevIsProtocol = looksLikeProtocol(prevRaw) && /^\d+$/.test(prevRaw.replace(/\D/g, '')) &&
    String(prevRaw).replace(/\D/g, '').length >= 9;

  // Obrigatório: agingIsStatus + prevIsProtocol (sinal confiável do deslocamento)
  return agingIsStatus && prevIsProtocol && (protHasMotivo || !looksLikeProtocol(prot));
}

/**
 * Aplica reparo V2. Só chamado quando `looksLikeMisalignedV2` retorna true.
 * @param {Record<string, unknown>} row
 * @returns {Record<string, unknown>}
 */
function repairMisalignedV2(row) {
  const out = { ...row };

  const protOriginal = String(row.Protocolo ?? row.protocolo ?? '');
  const agingRaw     = String(row['Aging Dias'] ?? '').trim();
  const prevRaw      = String(row['Data Previsão'] ?? row['Data Previsao'] ?? '').trim();
  const attRaw       = String(row['Situação Atendimento'] ?? row['Situacao Atendimento'] ?? '').trim();
  const defRaw       = String(row['Situação Deferimento'] ?? row['Situacao Deferimento'] ?? '').trim();
  const emailRaw     = String(row.Email ?? '').trim();
  const celRaw       = String(row.Celular ?? '').trim();
  const obsRaw       = String(row.Observação ?? row.Observacao ?? '').trim();
  const concRaw      = String(row['Data Conclusão'] ?? row['Data Conclusao'] ?? '').trim();

  // Protocolo real está em Data Previsão
  const protDigits = prevRaw.replace(/\D/g, '');
  if (!looksLikeProtocol(protDigits)) return row; // guard — não aplicar se não for válido
  out.Protocolo = protDigits;

  // Motivo/Submotivo original do campo Protocolo vai para Observação
  out.Observação = protOriginal;
  out.Observacao = protOriginal;

  // Status de atendimento: normalizar Aging Dias
  const agingNorm = normKey(agingRaw);
  let atendimento;
  if (agingNorm.includes('PEND')) atendimento = 'PENDENTE';
  else if (agingNorm.includes('CONCLU')) atendimento = 'CONCLUIDO';
  else if (agingNorm.includes('CANCEL')) atendimento = 'CANCELADO';
  else atendimento = agingRaw;
  out['Situação Atendimento'] = atendimento;
  out['Situacao Atendimento'] = atendimento;

  // Situação Deferimento: era o campo Observação original
  out['Situação Deferimento'] = obsRaw;
  out['Situacao Deferimento'] = obsRaw;

  // Celular: Situação Atendimento original se for só dígitos 10-13
  const attDigits = attRaw.replace(/\D/g, '');
  if (attDigits.length >= 10 && attDigits.length <= 13 && /^\d+$/.test(attRaw.replace(/[+()\s-]/g, ''))) {
    out.Celular = attDigits;
  } else {
    // fallback: tentar extrair de protOriginal (texto com "+55 (11) ...")
    const phoneMatch = protOriginal.match(/\+?55\s*\(?(\d{2})\)?\s*(\d{4,5})-?(\d{4})/);
    if (phoneMatch) {
      out.Celular = phoneMatch[1] + phoneMatch[2] + phoneMatch[3];
    } else {
      out.Celular = '';
    }
  }

  // Email: Situação Deferimento original se contém @
  if (defRaw.includes('@')) {
    out.Email = defRaw;
  }
  // se não, manter o que estava

  // Instituição: Email original se contém " - " (ex.: "UNICID - GRADUAÇÃO EAD")
  if (emailRaw.includes(' - ')) {
    out['Instituição'] = emailRaw;
    out['Instituicao'] = emailRaw;
  } else {
    out['Instituição'] = '';
    out['Instituicao'] = '';
  }

  // Curso: Celular original se NÃO for só dígitos 10-13
  const celDigitsOnly = celRaw.replace(/\D/g, '');
  if (!(celDigitsOnly.length >= 10 && celDigitsOnly.length <= 13 && celRaw === celRaw.replace(/\D/g, ''))) {
    out.Curso = celRaw;
  } else {
    out.Curso = '';
  }

  // Limpar campos que viraram lixo
  out['Aging Dias'] = '';
  out['Data Previsão'] = '';
  out['Data Previsao'] = '';

  // Data Conclusão: limpar se for "0" ou lixo numérico curto
  const concClean = concRaw.replace(/\D/g, '');
  if (!concRaw || concRaw === '0' || (concClean && !looksLikeProtocol(concClean))) {
    out['Data Conclusão'] = '';
    out['Data Conclusao'] = '';
  }

  return out;
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

/**
 * @param {Record<string, unknown>} row
 */
export function isCaaRowMisaligned(row) {
  if (!row || typeof row !== 'object') return false;
  if (looksLikeMisalignedV2(row)) return true;

  // V1 original
  const prot = String(row.Protocolo ?? row.protocolo ?? '').trim();
  const conc = String(row['Data Conclusão'] ?? row['Data Conclusao'] ?? '').trim();
  const obs = String(row.Observação ?? row.Observacao ?? '').trim();
  const att = String(row['Situação Atendimento'] ?? row['Situacao Atendimento'] ?? '').trim();

  const protBad = !prot || prot === '0' || prot.length < 6;
  const concIsProt = looksLikeProtocol(conc);
  const obsIsAtt = looksLikeAtendimentoStatus(obs);
  const attIsDefOnly = looksLikeDeferimentoStatus(att) && !looksLikeAtendimentoStatus(att);

  return (protBad && concIsProt) || (obsIsAtt && attIsDefOnly);
}

/**
 * @param {Record<string, unknown>} row
 * @returns {Record<string, unknown>}
 */
export function repairCaaExportRow(row) {
  if (!row || typeof row !== 'object') return row;

  // V2 tem prioridade — é padrão distinto do V1
  if (looksLikeMisalignedV2(row)) return repairMisalignedV2(row);

  // V1 original
  if (!isCaaRowMisaligned(row)) return row;

  const out = { ...row };
  const conc = String(out['Data Conclusão'] ?? out['Data Conclusao'] ?? '').trim();
  const obs = String(out.Observação ?? out.Observacao ?? '').trim();
  const att = String(out['Situação Atendimento'] ?? out['Situacao Atendimento'] ?? '').trim();
  const def = String(out['Situação Deferimento'] ?? out['Situacao Deferimento'] ?? '').trim();
  const cel = String(out.Celular ?? '').trim();
  const em = String(out.Email ?? '').trim();

  if (looksLikeProtocol(conc)) {
    out.Protocolo = conc.replace(/\D/g, '');
    out['Data Conclusão'] = '';
    out['Data Conclusao'] = '';
  }

  if (looksLikeAtendimentoStatus(obs)) {
    const a = normKey(obs);
    out['Situação Atendimento'] = a.includes('PEND') ? 'PENDENTE' : obs;
    out['Situacao Atendimento'] = out['Situação Atendimento'];
    if (a.includes('CONCLU') || a.includes('CANCEL') || a === 'EM ABERTO') {
      out['Situação Atendimento'] = a.includes('PEND') ? 'PENDENTE' : obs;
      out['Situacao Atendimento'] = out['Situação Atendimento'];
    }
  }

  if (looksLikeDeferimentoStatus(att) && !looksLikeAtendimentoStatus(att)) {
    out['Situação Deferimento'] = att;
    out['Situacao Deferimento'] = att;
  }

  if (looksLikePhone(def) && !looksLikeDeferimentoStatus(def)) {
    if (cel.includes('@')) {
      out.Email = cel;
      out.Celular = def.replace(/\D/g, '');
    } else if (looksLikeDeferimentoStatus(att)) {
      out.Celular = def.replace(/\D/g, '');
    }
  }

  if (em && !em.includes('@') && cel.includes('@')) {
    out.Email = cel;
    if (looksLikePhone(def)) out.Celular = def.replace(/\D/g, '');
  }

  return out;
}

/**
 * @param {Record<string, unknown>[]} objects
 * @param {{ sampleSize?: number }} [opts]
 */
export function validateCaaUploadRows(objects, opts = {}) {
  const sampleSize = opts.sampleSize ?? 200;
  const cancelamento = objects.filter((row) => {
    const sub = normKey(row.Subprocesso ?? row.subprocesso);
    return sub.includes('CANCELAMENTO') && sub.includes('MATRIC');
  });
  const sample = cancelamento.slice(0, sampleSize);
  if (!sample.length) {
    return {
      ok: false,
      misaligned_pct: 100,
      message:
        'Nenhuma linha de cancelamento de matrícula encontrada. Confira se o arquivo é o export CAA correto (data.xlsx).',
    };
  }
  const misaligned = sample.filter((r) => isCaaRowMisaligned(r)).length;
  const pct = Math.round((misaligned / sample.length) * 100);
  if (pct >= 25) {
    return {
      ok: false,
      misaligned_pct: pct,
      message:
        `O arquivo CAA está com colunas deslocadas em ~${pct}% das linhas de cancelamento. ` +
        'Verifique se o export está sendo gerado com o filtro correto. ' +
        'Tentamos corrigir automaticamente, mas é melhor exportar de novo.',
    };
  }
  return { ok: true, misaligned_pct: pct, message: null };
}
