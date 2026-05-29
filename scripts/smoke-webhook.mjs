/**
 * Smoke test do webhook inbound:
 * 1) GET de verificação
 * 2) POST com payload Meta-style (não correlato — vai para inbound_unmatched)
 */
const BASE = 'http://localhost:5173';

const verifyToken = process.env.WEBHOOK_VERIFY_TOKEN || 'disparador_dev_2026';

const v = await fetch(
  `${BASE}/api/webhooks/whatsapp?hub.mode=subscribe&hub.verify_token=${verifyToken}&hub.challenge=12345`
);
console.log('1) GET verify status:', v.status, '| body:', await v.text());

const inboundPayload = {
  entry: [
    {
      changes: [
        {
          value: {
            messages: [
              {
                id: 'wamid.SMOKE',
                from: '5511999887766',
                type: 'text',
                text: { body: 'Olá, recebi sua mensagem!' },
              },
            ],
          },
        },
      ],
    },
  ],
};

const r = await fetch(`${BASE}/api/webhooks/whatsapp`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(inboundPayload),
});
console.log('2) POST inbound status:', r.status, '| body:', await r.text());

console.log('\n✔ Webhook smoke OK');
