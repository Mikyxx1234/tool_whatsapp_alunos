import { datacrazyClient } from './datacrazyClient.js';
import { whatsappClient } from './whatsappClient.js';

/**
 * Provider único de envio de mensagens. Configurável via:
 *   MESSAGES_PROVIDER=whatsapp   (default — Cloud API da Meta, recomendado)
 *   MESSAGES_PROVIDER=datacrazy  (envia via DataCrazy CRM)
 *
 * Os argumentos esperados são iguais entre os dois:
 *   { phone, templateName, language, variables, templateComponents }
 */

export function getMessagesProviderName() {
  return (process.env.MESSAGES_PROVIDER || 'whatsapp').toLowerCase();
}

export async function sendTemplateMessage(params) {
  const provider = getMessagesProviderName();
  if (provider === 'datacrazy') {
    return datacrazyClient.sendTemplateMessage(params);
  }
  if (provider === 'whatsapp' || provider === 'meta' || provider === 'cloud') {
    return whatsappClient.sendTemplateMessage(params);
  }
  const err = new Error(
    `MESSAGES_PROVIDER inválido: "${provider}" (esperado "whatsapp" ou "datacrazy")`
  );
  err.status = 500;
  throw err;
}

export const messagingProvider = {
  getName: getMessagesProviderName,
  sendTemplateMessage,
};
