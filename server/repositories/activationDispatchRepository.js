import { query } from '../db/client.js';

/**
 * @param {string} category
 * @param {string[]} masterKeys
 */
export async function countSentByMasterKeys(category, masterKeys) {
  const keys = [...new Set(masterKeys.filter(Boolean))];
  if (!keys.length) return new Map();

  const { rows } = await query(
    `select master_key, count(*)::int as n
       from activation_dispatch_events
      where category = $1
        and status = 'sent'
        and master_key = any($2::text[])
      group by master_key`,
    [category, keys]
  );
  return new Map(rows.map((r) => [r.master_key, r.n]));
}

/** Contagens de envio por master_key em uma query (evita ANY com milhares de chaves). */
export async function countAllSentByCategory(category) {
  const { rows } = await query(
    `select master_key, count(*)::int as n
       from activation_dispatch_events
      where category = $1 and status = 'sent'
      group by master_key`,
    [category]
  );
  return new Map(rows.map((r) => [r.master_key, r.n]));
}

/**
 * @param {string} category
 */
export async function getDispatchedMasterKeys(category) {
  const { rows } = await query(
    `select distinct master_key
       from activation_dispatch_events
      where category = $1 and status = 'sent'`,
    [category]
  );
  return new Set(rows.map((r) => r.master_key));
}

/**
 * Retorna Map<master_key, lastSentAt(ISO)> para cálculo de cooldown.
 * Considera apenas eventos com status='sent'.
 * @param {string} category
 * @returns {Promise<Map<string, string>>}
 */
export async function getLastSentAtByMasterKey(category) {
  const { rows } = await query(
    `select master_key, max(created_at) as last_sent_at
       from activation_dispatch_events
      where category = $1 and status = 'sent' and master_key is not null
      group by master_key`,
    [category]
  );
  return new Map(rows.map((r) => [r.master_key, r.last_sent_at]));
}

/**
 * @param {object} event
 */
export async function recordDispatchEvent(event) {
  const {
    category,
    masterKey,
    status,
    channel = 'datacrazy',
    templateName = null,
    messageTier = null,
    datacrazyLeadId = null,
    nome = null,
    telefone = null,
    email = null,
    rgm = null,
    errorMessage = null,
    datacrazyNoteFailed = false,
    datacrazyNoteId = null,
  } = event;

  await query(
    `insert into activation_dispatch_events (
      category, master_key, status, channel, template_name, message_tier,
      datacrazy_lead_id, nome, telefone, email, rgm, error_message,
      datacrazy_note_failed, datacrazy_note_id
    ) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,
    [
      category,
      masterKey,
      status,
      channel,
      templateName,
      messageTier,
      datacrazyLeadId,
      nome,
      telefone,
      email,
      rgm,
      errorMessage,
      datacrazyNoteFailed,
      datacrazyNoteId,
    ]
  );
}

/** @deprecated use recordDispatchEvent */
export async function recordDispatches(category, masterKeys, meta = {}) {
  for (const key of masterKeys) {
    await recordDispatchEvent({
      category,
      masterKey: key,
      status: 'sent',
      channel: 'manual',
    });
  }
  return { inserted: masterKeys.length };
}

export async function countDispatched(category) {
  const { rows } = await query(
    `select count(distinct master_key)::int as n
       from activation_dispatch_events
      where category = $1 and status = 'sent'`,
    [category]
  );
  return rows[0]?.n ?? 0;
}

/**
 * Lista leads distintos disparados recentemente numa categoria, com datacrazy_lead_id preenchido.
 * Usado pelo sync de desfechos CAA.
 * @param {string} category
 * @param {number} days
 * @returns {Promise<Array<{ datacrazy_lead_id: string, rgm: string|null, nome: string|null, master_key: string|null }>>}
 */
export async function listRecentDispatchedLeadsForCategory(category, days) {
  const { rows } = await query(
    `select distinct on (datacrazy_lead_id)
            datacrazy_lead_id,
            rgm,
            nome,
            master_key
       from activation_dispatch_events
      where category = $1
        and status = 'sent'
        and datacrazy_lead_id is not null
        and created_at >= now() - ($2 || ' days')::interval
      order by datacrazy_lead_id, created_at desc`,
    [category, String(days)]
  );
  return rows;
}

/**
 * Último disparo bem-sucedido por master_key (qualquer categoria).
 * Usado no lookup local — evita API quando já ativamos a pessoa antes.
 * @param {string[]} masterKeys
 * @returns {Promise<Map<string, { master_key: string, datacrazy_lead_id: string, nome: string|null, telefone: string|null, email: string|null, rgm: string|null }>>}
 */
export async function getSentLeadsByMasterKeys(masterKeys) {
  const keys = [...new Set(masterKeys.filter(Boolean))];
  if (!keys.length) return new Map();
  const { rows } = await query(
    `select distinct on (master_key)
            master_key,
            datacrazy_lead_id,
            nome,
            telefone,
            email,
            rgm
       from activation_dispatch_events
      where status = 'sent'
        and datacrazy_lead_id is not null
        and trim(datacrazy_lead_id) <> ''
        and master_key = any($1::text[])
      order by master_key, created_at desc`,
    [keys]
  );
  return new Map(rows.map((r) => [r.master_key, r]));
}
