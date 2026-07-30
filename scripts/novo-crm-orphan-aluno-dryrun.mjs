/**
 * Prévia (dry-run) do provisionamento/dedupe de órfãos aluno no Novo CRM.
 * Só lê o banco (matriculados + cache) — não chama a API do CRM.
 *
 * Uso: node --env-file=.env scripts/novo-crm-orphan-aluno-dryrun.mjs [maxCreates] [--scope=orphans|incomplete|both]
 *
 * Exemplos:
 *   node --env-file=.env scripts/novo-crm-orphan-aluno-dryrun.mjs
 *   node --env-file=.env scripts/novo-crm-orphan-aluno-dryrun.mjs 500 --scope=both
 *   node --env-file=.env scripts/novo-crm-orphan-aluno-dryrun.mjs --scope=incomplete
 */
import 'dotenv/config';
import { previewOrphanAlunoProvision } from '../server/services/novoCrmOrphanAlunoProvisionService.js';

const args = process.argv.slice(2);
const scopeArg = args.find((a) => a.startsWith('--scope='));
const scope = scopeArg ? scopeArg.split('=')[1] : 'orphans';
const maxArg = args.find((a) => !a.startsWith('--'));
const maxCreates = maxArg ? Number(maxArg) || undefined : undefined;

const result = await previewOrphanAlunoProvision({ maxCreates, scope });

console.log(
  JSON.stringify(
    {
      scope: result.scope,
      matriculados_snapshot_id: result.matriculados_snapshot_id,
      matriculados_file: result.matriculados_file,
      index_by_email: result.index?.by_email,
      index_by_phone: result.index?.by_phone,
      cache_total: result.cache_total,
      orphans_total: result.orphans_total,
      orphan_aluno: result.orphan_aluno,
      orphan_no_match: result.orphan_no_match,
      matched_email: result.matched_email,
      matched_phone: result.matched_phone,
      dup_contact_skip: result.dup_contact_skip,
      dup_skip_no_deal: result.dup_skip_no_deal,
      dup_to_perdido: result.dup_to_perdido,
      deals_would_create_on_orphan: result.deals_would_create_on_orphan,
      deals_would_create_on_sibling: result.deals_would_create_on_sibling,
      deals_would_move_perdido: result.deals_would_move_perdido,
      incomplete_total: result.incomplete_total,
      incomplete_scanned: result.incomplete_scanned,
      incomplete_no_match: result.incomplete_no_match,
      incomplete_enriched: result.incomplete_enriched,
      incomplete_ambiguous: result.incomplete_ambiguous,
      incomplete_name_mismatch: result.incomplete_name_mismatch,
      incomplete_live_already_ok: result.incomplete_live_already_ok,
      incomplete_live_conflict: result.incomplete_live_conflict,
      incomplete_live_unknown: result.incomplete_live_unknown,
      perdido_skipped_live: result.perdido_skipped_live,
      perdido_live_unknown: result.perdido_live_unknown,
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
console.log('\n[skip_samples]', JSON.stringify(result.skip_samples?.slice(0, 15), null, 2));

process.exit(result?.ok ? 0 : 1);
