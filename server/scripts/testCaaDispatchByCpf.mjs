/**
 * Teste: dispara template por CPF (DataCrazy).
 * Uso: node server/scripts/testCaaDispatchByCpf.mjs [cpf] [categoria]
 *   categoria: processos-caa | financeiro | docs-pendentes | ...
 */
import 'dotenv/config';
import { query } from '../db/client.js';
import { datacrazyClient } from '../services/datacrazyClient.js';
import { messagingProvider } from '../services/messagingProvider.js';
import { whatsappClient } from '../services/whatsappClient.js';
import { resolveTemplateForActivation } from '../config/activationMessages.js';
import { getActivationTemplateConfig } from '../services/activationTemplateConfigService.js';
import * as activationDispatchRepo from '../repositories/activationDispatchRepository.js';
import { findRgmByCpfInMatriculados } from '../repositories/activationResponseRepository.js';
import { masterKeyFromParts } from '../utils/activationIdentity.js';

const cpfDigits = String(process.argv[2] || '44765254828').replace(/\D/g, '');
const category = String(process.argv[3] || 'processos-caa').trim();

function formatCpf(d) {
  if (d.length !== 11) return d;
  return `${d.slice(0, 3)}.${d.slice(3, 6)}.${d.slice(6, 9)}-${d.slice(9)}`;
}

async function findLeadByCpf() {
  const searches = [cpfDigits, formatCpf(cpfDigits)];
  for (const term of searches) {
    const page = await datacrazyClient.searchLeads({
      search: term,
      take: 20,
      completeAdditionalFields: true,
    });
    for (const lead of page.data || []) {
      const tax = String(lead.taxId || '').replace(/\D/g, '');
      if (tax === cpfDigits) return lead;
    }
  }
  // varredura curta por taxId em páginas
  let skip = 0;
  const take = 100;
  for (let p = 0; p < 30; p++) {
    const page = await datacrazyClient.searchLeads({ take, skip });
    for (const lead of page.data || []) {
      const tax = String(lead.taxId || '').replace(/\D/g, '');
      if (tax === cpfDigits) return lead;
    }
    if ((page.data || []).length < take) break;
    skip += take;
  }
  return null;
}

const stored = await getActivationTemplateConfig();
const templateName = resolveTemplateForActivation(category, 0, stored);
if (!templateName) {
  console.error(`Template ${category} 1ª ativação não configurado (UI ou ACTIVATION_TEMPLATE_*_FIRST)`);
  process.exit(1);
}

console.log('CPF:', cpfDigits, '| categoria:', category, '| template:', templateName);

const lead = await findLeadByCpf();
if (!lead?.id) {
  console.error('Lead não encontrado no DataCrazy para CPF', cpfDigits);
  process.exit(1);
}

let phone =
  datacrazyClient.normalizePhoneDigits(lead.rawPhone || lead.phone) || '';
if (!phone) {
  console.error('Lead sem telefone:', lead.id, lead.name);
  process.exit(1);
}
if (phone.length <= 11) phone = `55${phone}`;

console.log('Lead:', lead.id, lead.name, phone);
console.log('Provider:', messagingProvider.getName());

let rgm = await findRgmByCpfInMatriculados(cpfDigits);
if (!rgm && category === 'processos-caa') {
  const { rows: caaRows } = await query(
    `select rgm, nome from caa_protocols
     where regexp_replace(coalesce(cpf,''), '[^0-9]', '', 'g') = $1 limit 1`,
    [cpfDigits]
  );
  rgm = caaRows[0]?.rgm || '';
}

const variables = {
  nome: lead.name || '',
  polo: '',
  curso: '',
  rgm: rgm || '',
};

let templateComponents = [];
try {
  const templates = await whatsappClient.listTemplates();
  const tpl = templates.find((t) => t.name === templateName);
  templateComponents = tpl?.components || [];
} catch (e) {
  console.warn('listTemplates:', e.message);
}

console.log('Enviando template', templateName, '...');
const send = await messagingProvider.sendTemplateMessage({
  phone,
  templateName,
  language: process.env.ACTIVATION_TEMPLATE_LANGUAGE || 'pt_BR',
  variables,
  templateComponents,
});
console.log('Envio OK, messageId:', send.messageId);

const origem = await datacrazyClient.verifyOrigemAtivacaoForCategory(lead.id, category);
console.log('origem_ativacao:', origem);
if (!origem.ok) {
  console.error('origem_ativacao não confirmada — abortando histórico de disparo');
  process.exit(1);
}

const masterKey =
  masterKeyFromParts({ rgm, cpf: cpfDigits, telefone: phone }) || `CPF:${cpfDigits}`;
await activationDispatchRepo.recordDispatchEvent({
  category,
  masterKey,
  status: 'sent',
  channel: messagingProvider.getName(),
  messageTier: 'first',
  templateName,
  datacrazyLeadId: String(lead.id),
  nome: lead.name,
  telefone: phone,
  rgm: rgm || '',
});
console.log('Histórico gravado em activation_dispatch_events');
