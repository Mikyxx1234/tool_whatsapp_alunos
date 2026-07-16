import { query } from '../db/client.js';

/**
 * @param {object} row
 * @param {string} row.category
 * @param {string} row.tagName
 * @param {string|null} [row.tagId]
 * @param {string} row.tagValue  nome da tag no SET; '' no CLEAR
 * @param {string} row.contactId
 * @param {string|null} [row.dealId]
 * @param {string|null} [row.masterKey]
 * @param {string|null} [row.cpf]
 * @param {string|null} [row.rgm]
 * @param {string|null} [row.nome]
 * @param {'ok'|'failed'|'skipped'} row.status
 * @param {string|null} [row.errorMessage]
 */
export async function recordTagLog(row) {
  await query(
    `insert into activation_novo_crm_tag_log (
      category, tag_name, tag_id, tag_value, contact_id, deal_id,
      master_key, cpf, rgm, nome, status, error_message
    ) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
    [
      row.category,
      row.tagName,
      row.tagId ?? null,
      row.tagValue ?? '',
      row.contactId,
      row.dealId ?? null,
      row.masterKey ?? null,
      row.cpf ?? null,
      row.rgm ?? null,
      row.nome ?? null,
      row.status,
      row.errorMessage ?? null,
    ]
  );
}

/**
 * SETs ok (tag_value <> '') há mais de `hours` sem CLEAR posterior.
 * 1 linha por (contact_id, tag_name) — a mais recente.
 *
 * @param {number} hours
 */
export async function listStaleSetEntries(hours) {
  const safeHours = Math.max(1, Math.floor(Number(hours) || 72));
  const { rows } = await query(
    `select latest_set.contact_id, latest_set.deal_id, latest_set.category,
            latest_set.tag_name, latest_set.tag_id, latest_set.last_set_at,
            latest_set.tag_value, latest_set.nome, latest_set.rgm, latest_set.cpf,
            latest_set.master_key
       from (
         select distinct on (l.contact_id, l.tag_name)
           l.contact_id, l.deal_id, l.category, l.tag_name, l.tag_id,
           l.created_at as last_set_at, l.tag_value, l.nome, l.rgm, l.cpf, l.master_key
         from activation_novo_crm_tag_log l
         where l.status = 'ok'
           and l.tag_value <> ''
         order by l.contact_id, l.tag_name, l.created_at desc
       ) latest_set
      where latest_set.last_set_at < now() - ($1::int * interval '1 hour')
        and not exists (
          select 1 from activation_novo_crm_tag_log l2
          where l2.contact_id = latest_set.contact_id
            and l2.tag_name = latest_set.tag_name
            and l2.created_at > latest_set.last_set_at
            and l2.tag_value = ''
            and l2.status = 'ok'
        )`,
    [safeHours]
  );
  return rows;
}
