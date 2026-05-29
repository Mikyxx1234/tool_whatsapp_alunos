/* Smoke test do fluxo de exportação de leads não alcançados.
 * Não chama a DataCrazy: simula falhas direto no banco.
 *
 * Uso: node scripts/smoke-export.mjs
 */
import 'dotenv/config';
import { query } from '../server/db/client.js';

const API = process.env.API_BASE_URL || 'http://localhost:3001';

async function http(method, path, body) {
  const r = await fetch(`${API}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await r.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = { raw: text }; }
  if (!r.ok) {
    throw new Error(`${method} ${path} -> ${r.status}: ${JSON.stringify(data)}`);
  }
  return data;
}

async function main() {
  console.log('--- 1. cria campanha ---');
  const { campaign } = await http('POST', '/api/campaigns', {
    name: `Smoke export ${new Date().toISOString().slice(11, 19)}`,
    campaignTypeCode: 'FINANCEIRO',
    templateName: 'cobranca_inadimplente',
    templateLanguage: 'pt_BR',
    intervalSeconds: 1,
  });
  console.log('   id =', campaign.id);

  console.log('--- 2. adiciona contatos (mistura: validos, invalidos, duplicados) ---');
  const contacts = [
    { phone: '11999990001', normalizedPhone: '5511999990001', name: 'Ana',     validationStatus: 'valid' },
    { phone: '11999990002', normalizedPhone: '5511999990002', name: 'Bruno',   validationStatus: 'valid' },
    { phone: '11999990003', normalizedPhone: '5511999990003', name: 'Carla',   validationStatus: 'valid' },
    { phone: '11999990001', normalizedPhone: '5511999990001', name: 'Ana 2',   validationStatus: 'valid' }, // duplicado
    { phone: 'abc',         normalizedPhone: '',              name: 'Errado',  validationStatus: 'invalid', errorMessage: 'Telefone com formato inválido' },
  ];
  const ins = await http('POST', `/api/campaigns/${campaign.id}/contacts`, { contacts });
  console.log('   inseridos =', ins.insertedCount);

  console.log('--- 3. simula 2 falhas via SQL (Ana = sem WhatsApp, Bruno = erro genérico) ---');
  await query(
    `update whatsapp_campaign_contacts
        set send_status = 'failed',
            failure_reason = 'not_on_whatsapp',
            error_message = 'Recipient not found on WhatsApp',
            sent_at = null
      where campaign_id = $1 and normalized_phone = '5511999990001'
        and validation_status = 'valid'`,
    [campaign.id]
  );
  await query(
    `update whatsapp_campaign_contacts
        set send_status = 'failed',
            failure_reason = 'provider_error',
            error_message = 'Internal server error from provider'
      where campaign_id = $1 and normalized_phone = '5511999990002'`,
    [campaign.id]
  );
  await query(
    `update whatsapp_campaign_contacts
        set send_status = 'sent',
            sent_at = now()
      where campaign_id = $1 and normalized_phone = '5511999990003'`,
    [campaign.id]
  );

  console.log('--- 4. consulta /export-counts ---');
  const counts = await http('GET', `/api/campaigns/${campaign.id}/export-counts`);
  console.log('   counts =', counts.counts);
  // duplicates são descartados pelo unique index (campaign_id, normalized_phone)
  if (
    counts.counts.invalid !== 1 ||
    counts.counts.failed !== 2 ||
    counts.counts.not_on_whatsapp !== 1 ||
    counts.counts.sent !== 1
  ) {
    throw new Error(
      `Contagens divergentes do esperado: ${JSON.stringify(counts.counts)}`
    );
  }

  console.log('--- 5. baixa CSV (categories=not_on_whatsapp) ---');
  const csvNotOn = await fetch(
    `${API}/api/campaigns/${campaign.id}/contacts/export?categories=not_on_whatsapp`
  ).then((r) => r.text());
  console.log('   ---- CSV "não encontrados" ----');
  console.log(csvNotOn);

  console.log('--- 6. baixa CSV (categories=failed,invalid,duplicate) ---');
  const csvAll = await fetch(
    `${API}/api/campaigns/${campaign.id}/contacts/export?categories=failed,invalid,duplicate`
  ).then((r) => r.text());
  console.log('   ---- CSV consolidado ----');
  console.log(csvAll);

  console.log('OK ✔');
  process.exit(0);
}

main().catch((err) => {
  console.error('SMOKE FAIL:', err);
  process.exit(1);
});
