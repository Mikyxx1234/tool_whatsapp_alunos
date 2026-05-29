/* Smoke: chama o whatsappClient.sendTemplateMessage com um número claramente
 * inválido para confirmar que:
 *  - a Cloud API responde
 *  - o classifier mapeia o erro corretamente (not_on_whatsapp / invalid_number)
 * NÃO envia mensagem real para nenhum número válido.
 */
import 'dotenv/config';
import { whatsappClient } from '../server/services/whatsappClient.js';
import { classifyFailure } from '../server/utils/failureClassifier.js';

const PHONE = '5500000000000'; // claramente sem WhatsApp

try {
  const result = await whatsappClient.sendTemplateMessage({
    phone: PHONE,
    templateName: 'atv0405',
    language: 'pt_BR',
    variables: {},
    templateComponents: [
      { type: 'HEADER', text: 'Aviso Importante: Seus Estudos' },
      { type: 'BODY', text: 'Olá! ...' },
    ],
  });
  console.log('INESPERADO: enviou ->', result);
} catch (err) {
  console.log('--- erro recebido (esperado) ---');
  console.log('message:', err.message);
  console.log('status:', err.status);
  console.log('providerResponse:', JSON.stringify(err.providerResponse, null, 2));
  const reason = classifyFailure(err.message, err.providerResponse);
  console.log('classifyFailure:', reason);
}
process.exit(0);
