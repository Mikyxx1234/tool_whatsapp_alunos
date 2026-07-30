/**
 * Repara o espelho: contacts marcados como "sem negócio" que na verdade têm
 * deal(s) no CRM ao vivo (deriva de paginação do full sync).
 *
 * Uso:
 *   node scripts/novo-crm-repair-missing-deals.mjs            # aplica
 *   node scripts/novo-crm-repair-missing-deals.mjs --dry      # só conta
 *   node scripts/novo-crm-repair-missing-deals.mjs --limit=100
 */
import 'dotenv/config';
import fs from 'node:fs';
import * as cacheRepo from '../server/repositories/novoCrmPersonCacheRepository.js';
import { warmContactFromLive } from '../server/services/novoCrmCacheWarmService.js';
import { listDealsForContactId } from '../server/repositories/novoCrmPersonApiSourceRepository.js';

const args = process.argv.slice(2);
const dryRun = args.includes('--dry');
const limitArg = args.find((a) => a.startsWith('--limit='));
const limit = limitArg ? Number(limitArg.split('=')[1]) : Infinity;

function dealsFromCacheRow(row) {
  const byId = row?.raw_data?.dealsById;
  return byId && typeof byId === 'object' ? Object.values(byId) : [];
}

const rows = await cacheRepo.listActiveCacheRowsForEnrichment({
  scope: 'all_mapped',
  limit: 100000,
});
const orphans = rows
  .filter((r) => !r.primary_deal_id && dealsFromCacheRow(r).length === 0)
  .slice(0, Number.isFinite(limit) ? limit : undefined);

console.log(
  `[repair] espelho=${rows.length} · sem negócio=${orphans.length} · dry=${dryRun}`
);

let comDealLive = 0;
let semDealLive = 0;
let reparados = 0;
let erros = 0;
const samples = [];
const t0 = Date.now();

for (let i = 0; i < orphans.length; i += 1) {
  const row = orphans[i];
  const contactId = String(row.contact_id);
  try {
    const deals = await listDealsForContactId(contactId);
    if (!deals.length) {
      semDealLive += 1;
      continue;
    }
    comDealLive += 1;
    if (!dryRun) {
      await warmContactFromLive(contactId);
      reparados += 1;
    }
    if (samples.length < 20) {
      samples.push({
        contact_id: contactId,
        nome: row.nome,
        deals: deals.map((d) => d.number),
      });
    }
  } catch (err) {
    erros += 1;
    console.warn(`[repair] falha contact=${contactId}:`, err?.message || err);
  }
  if ((i + 1) % 50 === 0) {
    console.log(
      `[repair] ${i + 1}/${orphans.length} · com deal=${comDealLive} · reparados=${reparados} · erros=${erros}`
    );
  }
}

const resumo = {
  dry_run: dryRun,
  candidatos: orphans.length,
  ja_tem_deal_ao_vivo: comDealLive,
  realmente_sem_deal: semDealLive,
  reparados,
  erros,
  duracao_s: Math.round((Date.now() - t0) / 1000),
};
console.log(JSON.stringify(resumo, null, 2));
fs.writeFileSync(
  `data/repair-missing-deals-${Date.now()}.json`,
  JSON.stringify({ resumo, samples }, null, 2)
);
process.exit(0);
