/**
 * Cliente de envio de e-mail (stub).
 *
 * Por padrão (em desenvolvimento) loga o conteúdo no console e retorna
 * um messageId fake. Configure EMAIL_PROVIDER para integrar:
 *
 *   EMAIL_PROVIDER=mock     (default em dev)
 *   EMAIL_PROVIDER=resend   -> usa EMAIL_API_KEY (Resend)            TODO [CURSOR]
 *   EMAIL_PROVIDER=smtp     -> usa SMTP_HOST/PORT/USER/PASS         TODO [CURSOR]
 *   EMAIL_PROVIDER=sendgrid -> usa EMAIL_API_KEY (SendGrid)         TODO [CURSOR]
 */

function getProvider() {
  return (process.env.EMAIL_PROVIDER || 'mock').toLowerCase();
}

function buildMockMessageId() {
  return `mock-email-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

export async function sendEmailMessage({ to, subject, html, text, variables }) {
  const provider = getProvider();

  if (!to) {
    const err = new Error('Campo "to" é obrigatório no envio de e-mail.');
    err.status = 400;
    throw err;
  }

  if (provider === 'mock') {
    console.log(
      `[emailClient][mock] -> ${to} | subject="${subject || '(sem assunto)'}" | vars=${JSON.stringify(
        variables || {}
      )}`
    );
    return { messageId: buildMockMessageId(), raw: { mock: true } };
  }

  // TODO [CURSOR]: implementar Resend
  if (provider === 'resend') {
    if (!process.env.EMAIL_API_KEY) {
      throw new Error('EMAIL_API_KEY não configurada para Resend.');
    }
    throw new Error('Resend ainda não implementado. TODO [CURSOR].');
  }

  // TODO [CURSOR]: implementar SMTP
  if (provider === 'smtp') {
    throw new Error('Envio SMTP ainda não implementado. TODO [CURSOR].');
  }

  // TODO [CURSOR]: implementar SendGrid
  if (provider === 'sendgrid') {
    throw new Error('SendGrid ainda não implementado. TODO [CURSOR].');
  }

  throw new Error(`EMAIL_PROVIDER desconhecido: "${provider}".`);
}

export const emailClient = {
  sendEmailMessage,
  getProviderName: getProvider,
};
