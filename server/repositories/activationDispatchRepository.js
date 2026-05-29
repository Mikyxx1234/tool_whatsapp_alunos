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
  } = event;

  await query(
    `insert into activation_dispatch_events (
      category, master_key, status, channel, template_name, message_tier,
      datacrazy_lead_id, nome, telefone, email, rgm, error_message
    ) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
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
