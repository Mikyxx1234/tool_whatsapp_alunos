/**
 * Prévia (dry-run) do provisionamento de órfãos aluno no Novo CRM.
 * Só lê o banco (matriculados + cache) — não chama a API do CRM.
 *
 * Uso: node --env-file=.env scripts/novo-crm-orphan-aluno-dryrun.mjs [maxCreates]
 */
import 'dotenv/config';
import { previewOrphanAlunoProvision } from '../server/services/novoCrmOrphanAlunoProvisionService.js';

const maxCreates = Number(process.argv[2]) || undefined;

const result = await previewOrphanAlunoProvision({ maxCreates });

console.log(
  JSON.stringify(
    {
      matriculados_snapshot_id: result.matriculados_snapshot_id,
      matriculados_file: result.matriculados_file,
      index_by_email: result.index?.by_email,
      cache_total: result.cache_total,
      orphans_total: result.orphans_total,
      orphan_aluno: result.orphan_aluno,
      orphan_no_match: result.orphan_no_match,
      dup_contact_skip: result.dup_contact_skip,
      deals_would_create_on_orphan: result.deals_would_create_on_orphan,
      deals_would_create_on_sibling: result.deals_would_create_on_sibling,
      created_deals: result.created_deals,
      errors: result.errors,
      max_creates: result.max_creates,
      stopped_at_max: result.stopped_at_max,
    },
    null,
    2
  )
);
console.log('\n[samples]', JSON.stringify(result.samples?.slice(0, 10), null, 2));

process.exit(result?.ok ? 0 : 1);
