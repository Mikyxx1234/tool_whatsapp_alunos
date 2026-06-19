import { query } from '../db/client.js';

/**
 * Lista leads com `origem_ativacao` SET (status='ok', origem_value != '')
 * há mais de `hours` horas, SEM CLEAR posterior. 1 linha por lead (a mais recente).
 *
 * Usado pelo job de limpeza pra identificar leads que ficaram com o campo
 * preenchido no CRM porque a pessoa nunca respondeu — e portanto o
 * handshake n8n nunca limpou.
 *
 * @param {number} hours
 * @returns {Promise<Array<{
 *   datacrazy_lead_id: string,
 *   category: string,
 *   master_key: string|null,
 *   last_set_at: string,
 *   origem_value: string,
 *   nome: string|null,
 *   rgm: string|null,
 *   cpf: string|null
 * }>>}
 */
export async function listStaleSetEntries(hours) {
  const safeHours = Math.max(1, Math.floor(Number(hours) || 72));
  const { rows } = await query(
    `select latest_set.datacrazy_lead_id, latest_set.category, latest_set.master_key,
            latest_set.last_set_at, latest_set.origem_value,
            latest_set.nome, latest_set.rgm, latest_set.cpf
       from (
         select distinct on (l.datacrazy_lead_id)
           l.datacrazy_lead_id, l.category, l.master_key,
           l.created_at as last_set_at, l.origem_value, l.nome, l.rgm, l.cpf
         from activation_origem_ativacao_log l
         where l.status = 'ok'
           and l.origem_value <> ''
         order by l.datacrazy_lead_id, l.created_at desc
       ) latest_set
      where latest_set.last_set_at < now() - ($1::int * interval '1 hour')
        and not exists (
          select 1 from activation_origem_ativacao_log l2
          where l2.datacrazy_lead_id = latest_set.datacrazy_lead_id
            and l2.created_at > latest_set.last_set_at
            and l2.origem_value = ''
            and l2.status = 'ok'
        )`,
    [safeHours]
  );
  return rows;
}

/**
 * Dispatches `sent` há mais de N horas sem CLEAR ok no log depois do disparo.
 * Cobre leads cujo PUT gravou no CRM mas o insert no log falhou (silencioso).
 *
 * @param {number} hours
 */
export async function listStaleDispatchEntriesWithoutClear(hours) {
  const safeHours = Math.max(1, Math.floor(Number(hours) || 72));
  const { rows } = await query(
    `select distinct on (d.datacrazy_lead_id)
       d.datacrazy_lead_id, d.category, d.master_key,
       d.created_at as last_set_at,
       '' as origem_value,
       d.nome, d.rgm, null::text as cpf
     from activation_dispatch_events d
     where d.status = 'sent'
       and d.datacrazy_lead_id is not null
       and trim(d.datacrazy_lead_id) <> ''
       and d.created_at < now() - ($1::int * interval '1 hour')
       and not exists (
         select 1 from activation_origem_ativacao_log l2
         where l2.datacrazy_lead_id = d.datacrazy_lead_id
           and l2.origem_value = ''
           and l2.status = 'ok'
           and l2.created_at >= d.created_at
       )
     order by d.datacrazy_lead_id, d.created_at desc`,
    [safeHours]
  );
  return rows;
}

/**
 * @param {object} row
 * @param {string} row.category
 * @param {string|null} [row.origemValue]
 * @param {string} row.datacrazyLeadId
 * @param {string} [row.masterKey]
 * @param {string} [row.cpf]
 * @param {string} [row.rgm]
 * @param {string} [row.nome]
 * @param {'ok'|'failed'|'skipped'} row.status
 * @param {string} [row.errorMessage]
 */
export async function recordOrigemAtivacaoLog(row) {
  await query(
    `insert into activation_origem_ativacao_log (
      category, origem_value, datacrazy_lead_id, master_key,
      cpf, rgm, nome, status, error_message
    ) values ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
    [
      row.category,
      row.origemValue ?? '',
      row.datacrazyLeadId,
      row.masterKey ?? null,
      row.cpf ?? null,
      row.rgm ?? null,
      row.nome ?? null,
      row.status,
      row.errorMessage ?? null,
    ]
  );
}
