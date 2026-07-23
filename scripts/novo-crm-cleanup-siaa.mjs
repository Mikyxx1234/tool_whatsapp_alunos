/**
 * Limpa do CRM DEV os contatos criados pelo provisionamento (source='SIAA')
 * e seus negócios. NÃO toca em contatos de outra origem. DEV-only.
 *
 * Uso: node --env-file=.env scripts/novo-crm-cleanup-siaa.mjs [--dry]
 */
import { forceNovoCrmDevEnv } from './_novoCrmDevEnv.mjs';

const { base } = forceNovoCrmDevEnv();

const dryRun = process.argv.includes('--dry');
const { listContactsPage, listDealsPage, deleteContact, deleteDeal } = await import(
  '../server/services/novoCrmClient.js'
);

// 1) deal órfão conhecido do smoke (contato já deletado no teste do DELETE)
const orphanDeals = ['cmruqjj4p005lqf01dug2q3co'];

// 2) coleta todos os contatos source='SIAA'
const siaa = [];
let page = 1;
let totalPages = null;
while (true) {
  const res = await listContactsPage({ page, perPage: 200 });
  for (const c of res.items) {
    if (String(c.source || '').trim().toUpperCase() === 'SIAA') siaa.push(c.id);
  }
  totalPages = res.totalPages ?? Math.ceil((res.total || 0) / (res.perPage || 200));
  if (!res.items.length || (totalPages && page >= totalPages)) break;
  page += 1;
}
console.log(`[cleanup] base=${base} contatos source=SIAA: ${siaa.length} (dry=${dryRun})`);

let delDeals = 0;
let delContacts = 0;
let errs = 0;

for (const dealId of orphanDeals) {
  if (dryRun) {
    delDeals++;
    continue;
  }
  try {
    await deleteDeal(dealId);
    delDeals++;
  } catch (e) {
    if (e.status !== 404) {
      errs++;
      console.warn('orfao', dealId, e.message);
    }
  }
}

for (const contactId of siaa) {
  try {
    const deals = await listDealsPage({ contactId, perPage: 100 });
    for (const d of deals.items) {
      if (dryRun) {
        delDeals++;
        continue;
      }
      try {
        await deleteDeal(d.id);
        delDeals++;
      } catch (e) {
        errs++;
        console.warn('deal', d.id, e.message);
      }
    }
    if (dryRun) {
      delContacts++;
      continue;
    }
    await deleteContact(contactId);
    delContacts++;
    if (delContacts % 50 === 0) console.log(`[cleanup] progresso: ${delContacts} contatos, ${delDeals} deals`);
  } catch (e) {
    errs++;
    console.warn('contato', contactId, e.message);
  }
}

console.log(`[cleanup] done: contatos=${delContacts} deals=${delDeals} erros=${errs} dry=${dryRun}`);
process.exit(0);
