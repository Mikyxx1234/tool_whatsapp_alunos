/**
 * Versão server-side da normalização brasileira (espelha src/utils/phoneNormalizer.ts).
 */
export function normalizeBrazilianPhone(input) {
  if (!input) return { ok: false, phone: '', reason: 'vazio' };
  const digits = String(input).replace(/\D+/g, '');
  if (!digits) return { ok: false, phone: '', reason: 'sem dígitos' };

  if (digits.startsWith('55')) {
    const local = digits.slice(2);
    if (local.length !== 10 && local.length !== 11) {
      return {
        ok: false,
        phone: digits,
        reason: 'após o 55 deve haver 10 ou 11 dígitos',
      };
    }
    return { ok: true, phone: `55${local}` };
  }
  if (digits.length === 10 || digits.length === 11) {
    return { ok: true, phone: `55${digits}` };
  }
  return {
    ok: false,
    phone: digits,
    reason: 'telefone deve ter 10 ou 11 dígitos (sem DDI) ou começar com 55',
  };
}
