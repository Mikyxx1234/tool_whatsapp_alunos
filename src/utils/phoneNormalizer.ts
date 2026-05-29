/**
 * Normalização de telefones brasileiros para o formato exigido pelo WhatsApp:
 *   - apenas dígitos
 *   - DDI 55 no início
 *   - DDD + número (10 ou 11 dígitos antes do DDI)
 *
 * Exemplos:
 *   "(11) 99988-7766"  -> "5511999887766"
 *   "11 99988-7766"    -> "5511999887766"
 *   "+55 11 99988-7766"-> "5511999887766"
 *   "5511999887766"    -> "5511999887766"
 *   "1199887766"       -> "551199887766"  (10 dígitos: fixo)
 *   "999"              -> inválido
 */

export interface NormalizedPhone {
  ok: boolean;
  phone: string;
  reason?: string;
}

export function normalizeBrazilianPhone(input: string): NormalizedPhone {
  if (!input) {
    return { ok: false, phone: '', reason: 'vazio' };
  }

  const onlyDigits = String(input).replace(/\D+/g, '');

  if (!onlyDigits) {
    return { ok: false, phone: '', reason: 'sem dígitos' };
  }

  const digits = onlyDigits;

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

export function formatPhoneForDisplay(phone: string): string {
  if (!phone) return '';
  const digits = phone.replace(/\D+/g, '');
  if (digits.length < 12) return phone;
  const country = digits.slice(0, 2);
  const ddd = digits.slice(2, 4);
  const rest = digits.slice(4);
  if (rest.length === 9) {
    return `+${country} (${ddd}) ${rest.slice(0, 5)}-${rest.slice(5)}`;
  }
  if (rest.length === 8) {
    return `+${country} (${ddd}) ${rest.slice(0, 4)}-${rest.slice(4)}`;
  }
  return `+${country} ${ddd} ${rest}`;
}
