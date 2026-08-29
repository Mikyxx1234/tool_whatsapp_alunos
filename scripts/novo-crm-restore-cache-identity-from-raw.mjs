/**
 * Restaura cpf_norm/rgm_norm a partir de raw_data.dealsById.*.customFields.
 * Não toca o CRM. Usar após Full FETCH=0 que zerou as colunas mas preservou o JSON.
 *
 *   node --env-file=.env scripts/novo-crm-restore-cache-identity-from-raw.mjs
 *   node --env-file=.env scripts/novo-crm-restore-cache-identity-from-raw.mjs --ack-alerts
 */
import { query, getPool } from '../server/db/client.js';

const ackAlerts = process.argv.includes('--ack-alerts');

const { rows: before } = await query(`
  select
    count(*) filter (where is_deleted = false)::int as active,
    count(*) filter (where is_deleted = false and (cpf_norm is null or btrim(cpf_norm) = ''))::int as missing_cpf,
    count(*) filter (where is_deleted = false and (rgm_norm is null or btrim(rgm_norm) = ''))::int as missing_rgm
  from novo_crm_person_cache
`);

const { rowCount } = await query(`
  with extracted as (
    select
      c.contact_id,
      (
        select regexp_replace(f->>'value', '\\D', '', 'g')
          from jsonb_each(coalesce(c.raw_data->'dealsById', '{}'::jsonb)) d,
               jsonb_array_elements(coalesce(d.value->'customFields', '[]'::jsonb)) f
         where coalesce(f->>'value', '') <> ''
           and (
             lower(coalesce(f->>'name', '')) in ('cpf', 'documento', 'taxid')
             or f->>'id' = 'cmrnpd33ekm5snm01jecpmevp'
           )
         limit 1
      ) as cpf_digits,
      (
        select regexp_replace(f->>'value', '\\D', '', 'g')
          from jsonb_each(coalesce(c.raw_data->'dealsById', '{}'::jsonb)) d,
               jsonb_array_elements(coalesce(d.value->'customFields', '[]'::jsonb)) f
         where coalesce(f->>'value', '') <> ''
           and (
             lower(coalesce(f->>'name', '')) = 'rgm'
             or f->>'id' = 'cmrmexurt18tfnm01e6krzug6'
           )
         limit 1
      ) as rgm_digits
    from novo_crm_person_cache c
    where c.is_deleted = false
      and (
        c.cpf_norm is null or btrim(c.cpf_norm) = ''
        or c.rgm_norm is null or btrim(c.rgm_norm) = ''
      )
  ),
  normalized as (
    select
      contact_id,
      case
        when length(cpf_digits) >= 9 and length(cpf_digits) < 11 then lpad(cpf_digits, 11, '0')
        when length(cpf_digits) = 11 then cpf_digits
        else null
      end as cpf_norm,
      case
        when length(rgm_digits) >= 6 then rgm_digits
        else null
      end as rgm_norm
    from extracted
  )
  update novo_crm_person_cache c
     set cpf_norm = coalesce(nullif(btrim(c.cpf_norm), ''), n.cpf_norm, c.cpf_norm),
         rgm_norm = coalesce(nullif(btrim(c.rgm_norm), ''), n.rgm_norm, c.rgm_norm),
         last_synced_at = now()
    from normalized n
   where c.contact_id = n.contact_id
     and (
       ((c.cpf_norm is null or btrim(c.cpf_norm) = '') and n.cpf_norm is not null)
       or ((c.rgm_norm is null or btrim(c.rgm_norm) = '') and n.rgm_norm is not null)
     )
`);

const { rows: after } = await query(`
  select
    count(*) filter (where is_deleted = false)::int as active,
    count(*) filter (where is_deleted = false and (cpf_norm is null or btrim(cpf_norm) = ''))::int as missing_cpf,
    count(*) filter (where is_deleted = false and (rgm_norm is null or btrim(rgm_norm) = ''))::int as missing_rgm
  from novo_crm_person_cache
`);

let acked = 0;
if (ackAlerts) {
  const { rows } = await query(`
    update novo_crm_data_loss_events
       set acknowledged_at = now(),
           acknowledged_by = 'restore-cache-identity-from-raw'
     where acknowledged_at is null
     returning id
  `);
  acked = rows.length;
}

console.log(JSON.stringify({
  updated_rows: rowCount ?? 0,
  before: before[0],
  after: after[0],
  alerts_acked: acked,
}, null, 2));

await getPool().end();
