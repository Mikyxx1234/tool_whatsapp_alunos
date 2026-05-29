/**
 * Classifica uma falha de envio em uma categoria estável,
 * baseada na mensagem de erro e/ou no payload de resposta do provedor.
 *
 * Regras heurísticas — ajustar conforme a DataCrazy documentar
 * códigos de erro reais (TODO [CURSOR]).
 */

const PATTERNS = [
  {
    reason: 'not_on_whatsapp',
    needles: [
      'not on whatsapp',
      'no whatsapp',
      'no whatsapp account',
      'whatsapp not registered',
      'recipient not found',
      'phone not found',
      'numero nao encontrado',
      'número não encontrado',
      'numero invalido whatsapp',
      'no_whatsapp_account',
      'not_a_whatsapp_number',
      'lead not found',
      'lead nao encontrado',
      'destination not exists',
    ],
    codes: [131026, 470, 1013, 'NO_WHATSAPP_ACCOUNT'],
  },
  {
    reason: 'invalid_number',
    needles: [
      'invalid phone',
      'invalid number',
      'invalid recipient',
      'numero invalido',
      'número inválido',
      'malformed phone',
    ],
    codes: [131009, 'INVALID_PHONE'],
  },
  {
    reason: 'rate_limited',
    needles: [
      'rate limit',
      'too many requests',
      'limite de envio',
      'limite atingido',
      'quota exceeded',
    ],
    codes: [429, 80007, 'RATE_LIMIT'],
  },
  {
    reason: 'template_rejected',
    needles: [
      'template not found',
      'template_not_found',
      'template rejected',
      'template invalido',
      'template inválido',
      'template paused',
      'template disabled',
    ],
    codes: [132000, 132001, 132005, 132007, 132012, 132015],
  },
  {
    reason: 'auth_error',
    needles: [
      'unauthorized',
      'invalid token',
      'token expirado',
      'access denied',
      'forbidden',
      'auth',
    ],
    codes: [401, 403],
  },
  {
    reason: 'network_error',
    needles: [
      'timeout',
      'network',
      'econnreset',
      'econnrefused',
      'enotfound',
      'socket hang up',
      'fetch failed',
    ],
  },
];

function extractCodes(providerResponse) {
  if (!providerResponse || typeof providerResponse !== 'object') return [];
  const out = [];
  const root = providerResponse.error || providerResponse;
  if (root.code !== undefined) out.push(root.code);
  if (root.error_code !== undefined) out.push(root.error_code);
  if (root.errorCode !== undefined) out.push(root.errorCode);
  if (root.error_subcode !== undefined) out.push(root.error_subcode);
  if (root.statusCode !== undefined) out.push(root.statusCode);
  if (root.status !== undefined) out.push(root.status);
  return out;
}

export function classifyFailure(errorMessage = '', providerResponse = null) {
  const haystack = String(errorMessage || '').toLowerCase();
  const codes = extractCodes(providerResponse);

  for (const rule of PATTERNS) {
    if (rule.needles?.some((n) => haystack.includes(n))) return rule.reason;
    if (rule.codes?.some((code) => codes.some((c) => String(c) === String(code)))) {
      return rule.reason;
    }
  }
  return 'provider_error';
}

export const FAILURE_REASON_LABELS = {
  not_on_whatsapp: 'Sem WhatsApp',
  invalid_number: 'Número inválido',
  rate_limited: 'Limite excedido',
  template_rejected: 'Template rejeitado',
  auth_error: 'Erro de autenticação',
  provider_error: 'Erro do provedor',
  network_error: 'Falha de conexão',
  unknown: 'Não classificado',
};
