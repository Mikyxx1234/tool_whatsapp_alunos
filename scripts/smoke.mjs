/**
 * Smoke test ponta a ponta:
 * 1) GET /api/campaign-types
 * 2) POST /api/campaigns
 * 3) POST /api/campaigns/:id/contacts (3 contatos: 1 inválido, 2 válidos sendo 1 dup)
 * 4) GET /api/campaigns/:id  (vê totais)
 * 5) GET /api/campaigns/:id/contacts (vê classificação)
 *
 * NÃO inicia disparo (evita disparar mensagem real). O fluxo de start já é
 * coberto pelo polling do frontend.
 */
const BASE = 'http://localhost:5173';

async function j(path, init) {
  const r = await fetch(`${BASE}${path}`, {
    ...init,
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/json',
      ...(init?.headers || {}),
    },
  });
  const text = await r.text();
  let data;
  try { data = JSON.parse(text); } catch { data = text; }
  if (!r.ok) {
    throw new Error(`${path} ${r.status}: ${typeof data === 'string' ? data : JSON.stringify(data)}`);
  }
  return data;
}

const types = await j('/api/campaign-types');
console.log('1) Tipos:', types.campaignTypes.map(t => t.code).join(', '));

const created = await j('/api/campaigns', {
  method: 'POST',
  body: JSON.stringify({
    name: `Smoke test ${new Date().toISOString().slice(11,19)}`,
    campaignTypeCode: 'FINANCEIRO',
    templateName: 'inad_geral',
    templateLanguage: 'pt_BR',
    templateCategory: 'UTILITY',
    intervalSeconds: 5,
    dailyLimit: 100,
    sourceFileName: 'smoke.csv',
  }),
});
console.log('2) Campanha criada:', created.campaign.id, '| status:', created.campaign.status);

const contactsPayload = {
  contacts: [
    { phone: '11999887766', normalizedPhone: '5511999887766', name: 'Aluno Um',  email: 'um@ex.com',  validationStatus: 'valid' },
    { phone: '11999887766', normalizedPhone: '5511999887766', name: 'Aluno Um (dup)', validationStatus: 'valid' },
    { phone: '21988776655', normalizedPhone: '5521988776655', name: 'Aluno Dois', validationStatus: 'valid' },
    { phone: 'abc',         normalizedPhone: '',              name: 'Inválido',   validationStatus: 'invalid', errorMessage: 'sem dígitos' },
  ],
  sourceFileName: 'smoke.csv',
};
const inserted = await j(`/api/campaigns/${created.campaign.id}/contacts`, {
  method: 'POST',
  body: JSON.stringify(contactsPayload),
});
console.log('3) Inseridos:', inserted.insertedCount,
            '| totals:',
            'contacts=', inserted.campaign.total_contacts,
            'valid=', inserted.campaign.total_valid,
            'invalid=', inserted.campaign.total_invalid,
            'duplicates=', inserted.campaign.total_duplicates);

const detail = await j(`/api/campaigns/${created.campaign.id}`);
console.log('4) Detalhe campanha:', JSON.stringify({
  status: detail.campaign.status,
  total_contacts: detail.campaign.total_contacts,
  total_valid: detail.campaign.total_valid,
  total_invalid: detail.campaign.total_invalid,
  total_duplicates: detail.campaign.total_duplicates,
}));

const list = await j(`/api/campaigns/${created.campaign.id}/contacts`);
console.log('5) Contatos:');
for (const c of list.contacts) {
  console.log(`   - ${c.normalized_phone || c.phone} | val=${c.validation_status} | send=${c.send_status} | ${c.name || ''}`);
}

console.log('\n✔ Smoke OK');
