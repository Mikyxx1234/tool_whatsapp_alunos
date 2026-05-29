import { query, withTransaction } from '../db/client.js';

const FIELDS = `
  id, campaign_id, phone, normalized_phone, name, email, student_id, cpf,
  course, origem, raw_data, validation_status, send_status, interaction_status,
  duplicate_key, error_message, failure_reason, sent_at, delivered_at, read_at,
  first_interaction_at, last_interaction_at, created_at, updated_at
`;

/**
 * Insere uma lista de contatos da campanha em lote.
 * Em caso de telefone duplicado dentro da mesma campanha, mantém o primeiro
 * e marca os subsequentes como `duplicate` na própria função (a unique index
 * é garantida no banco).
 */
export async function bulkInsert(campaignId, contacts) {
  if (!Array.isArray(contacts) || contacts.length === 0) {
    return [];
  }

  return withTransaction(async (client) => {
    const seen = new Set();
    const inserted = [];

    for (const c of contacts) {
      const validationStatus = c.validationStatus || 'pending';
      const normalized = c.normalizedPhone || '';

      let finalValidation = validationStatus;
      let duplicateKey = null;
      if (validationStatus === 'valid' && normalized) {
        if (seen.has(normalized)) {
          finalValidation = 'duplicate';
          duplicateKey = normalized;
        } else {
          seen.add(normalized);
        }
      }

      const { rows } = await client.query(
        `insert into whatsapp_campaign_contacts
           (campaign_id, phone, normalized_phone, name, email, student_id, cpf,
            course, origem, raw_data, validation_status, error_message, duplicate_key)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
         on conflict (campaign_id, normalized_phone) do nothing
         returning ${FIELDS}`,
        [
          campaignId,
          c.phone || normalized,
          normalized || c.phone || '',
          c.name || null,
          c.email || null,
          c.studentId || null,
          c.cpf || null,
          c.course || null,
          c.origem || null,
          c.rawData ? JSON.stringify(c.rawData) : null,
          finalValidation,
          c.errorMessage || null,
          duplicateKey,
        ]
      );
      if (rows[0]) inserted.push(rows[0]);
    }

    return inserted;
  });
}

export async function listByCampaign(campaignId, { limit = 500, offset = 0, status } = {}) {
  const params = [campaignId];
  let where = 'where campaign_id = $1';
  if (status) {
    params.push(status);
    where += ` and send_status = $${params.length}`;
  }
  params.push(limit);
  params.push(offset);
  const { rows } = await query(
    `select ${FIELDS} from whatsapp_campaign_contacts
       ${where}
       order by created_at asc
       limit $${params.length - 1} offset $${params.length}`,
    params
  );
  return rows;
}

export async function listValidPending(campaignId, client) {
  const exec = client ? client.query.bind(client) : query;
  const { rows } = await exec(
    `select ${FIELDS} from whatsapp_campaign_contacts
       where campaign_id = $1
         and validation_status = 'valid'
         and send_status in ('pending','queued','failed')
       order by created_at asc`,
    [campaignId]
  );
  return rows;
}

export async function findById(id, client) {
  const exec = client ? client.query.bind(client) : query;
  const { rows } = await exec(
    `select ${FIELDS} from whatsapp_campaign_contacts where id = $1 limit 1`,
    [id]
  );
  return rows[0] || null;
}

/**
 * Marca como duplicata quem já recebeu o mesmo template WhatsApp (outra campanha).
 * @returns {Promise<number>}
 */
export async function markDuplicatesSameTemplateAlreadySent(
  campaignId,
  { templateName, templateLanguage },
  client
) {
  if (!templateName) return 0;
  const exec = client ? client.query.bind(client) : query;
  const lang = templateLanguage || 'pt_BR';
  const msg = `Já recebeu este template (${templateName}) em disparo anterior.`;
  const { rowCount } = await exec(
    `update whatsapp_campaign_contacts cur
        set validation_status = 'duplicate',
            duplicate_key     = cur.normalized_phone,
            error_message     = $4,
            updated_at        = now()
       from whatsapp_campaign_contacts prev
       join whatsapp_campaigns camp on camp.id = prev.campaign_id
      where cur.campaign_id = $1
        and cur.validation_status = 'valid'
        and prev.campaign_id <> $1
        and prev.send_status = 'sent'
        and prev.normalized_phone = cur.normalized_phone
        and camp.template_name = $2
        and coalesce(camp.template_language, 'pt_BR') = $3`,
    [campaignId, templateName, lang, msg]
  );
  return rowCount ?? 0;
}

/**
 * @param {string} normalizedPhone
 * @param {string} templateName
 * @param {string} [templateLanguage]
 * @param {string} [excludeCampaignId]
 */
export async function wasTemplateSentToPhone(
  normalizedPhone,
  templateName,
  templateLanguage = 'pt_BR',
  excludeCampaignId = null
) {
  if (!normalizedPhone || !templateName) return false;
  const params = [normalizedPhone, templateName, templateLanguage || 'pt_BR'];
  let excludeSql = '';
  if (excludeCampaignId) {
    params.push(excludeCampaignId);
    excludeSql = ` and prev.campaign_id <> $${params.length}`;
  }
  const { rows } = await query(
    `select 1
       from whatsapp_campaign_contacts prev
       join whatsapp_campaigns camp on camp.id = prev.campaign_id
      where prev.normalized_phone = $1
        and prev.send_status = 'sent'
        and camp.template_name = $2
        and coalesce(camp.template_language, 'pt_BR') = $3
        ${excludeSql}
      limit 1`,
    params
  );
  return rows.length > 0;
}

export async function findLatestByPhone(normalizedPhone, withinHours = 168) {
  const { rows } = await query(
    `select cc.*
       from whatsapp_campaign_contacts cc
       join whatsapp_campaigns c on c.id = cc.campaign_id
       where cc.normalized_phone = $1
         and cc.sent_at is not null
         and cc.sent_at >= now() - ($2 || ' hours')::interval
       order by cc.sent_at desc
       limit 1`,
    [normalizedPhone, String(withinHours)]
  );
  return rows[0] || null;
}

export async function updateSendStatus(id, status, extras = {}, client) {
  const exec = client ? client.query.bind(client) : query;
  const setClauses = ['send_status = $1'];
  const params = [status];

  for (const [key, value] of Object.entries(extras)) {
    params.push(value);
    setClauses.push(`${key} = $${params.length}`);
  }

  params.push(id);
  const { rows } = await exec(
    `update whatsapp_campaign_contacts
       set ${setClauses.join(', ')}
       where id = $${params.length}
       returning ${FIELDS}`,
    params
  );
  return rows[0] || null;
}

export async function markInteracted(id, when, client) {
  const exec = client ? client.query.bind(client) : query;
  const { rows } = await exec(
    `update whatsapp_campaign_contacts
       set interaction_status   = 'interacted',
           first_interaction_at = coalesce(first_interaction_at, $1),
           last_interaction_at  = $1
       where id = $2
       returning ${FIELDS}`,
    [when, id]
  );
  return rows[0] || null;
}

export async function markNotInteracted(campaignId, hoursAfterSend, client) {
  const exec = client ? client.query.bind(client) : query;
  const { rowCount } = await exec(
    `update whatsapp_campaign_contacts
       set interaction_status = 'not_interacted'
       where campaign_id = $1
         and send_status = 'sent'
         and interaction_status = 'unknown'
         and sent_at <= now() - ($2 || ' hours')::interval`,
    [campaignId, String(hoursAfterSend)]
  );
  return rowCount;
}

/**
 * Lista contatos para exportação. Aceita uma combinação de "categorias":
 *  - 'invalid'         → validation_status = 'invalid'
 *  - 'duplicate'       → validation_status = 'duplicate'
 *  - 'failed'          → send_status = 'failed' (qualquer motivo)
 *  - 'not_on_whatsapp' → send_status = 'failed' AND failure_reason = 'not_on_whatsapp'
 *  - 'sent'            → send_status = 'sent'
 *  - 'pending'         → send_status in ('pending','queued','sending')
 */
export async function listForExport(campaignId, categories = []) {
  const cats = Array.isArray(categories) ? categories : [categories];
  if (cats.length === 0) return [];

  const conditions = [];
  for (const cat of cats) {
    if (cat === 'invalid') conditions.push(`validation_status = 'invalid'`);
    else if (cat === 'duplicate') conditions.push(`validation_status = 'duplicate'`);
    else if (cat === 'failed') conditions.push(`send_status = 'failed'`);
    else if (cat === 'not_on_whatsapp')
      conditions.push(
        `(send_status = 'failed' and failure_reason = 'not_on_whatsapp')`
      );
    else if (cat === 'sent') conditions.push(`send_status = 'sent'`);
    else if (cat === 'pending')
      conditions.push(`send_status in ('pending','queued','sending')`);
  }
  if (conditions.length === 0) return [];

  const { rows } = await query(
    `select ${FIELDS}
       from whatsapp_campaign_contacts
      where campaign_id = $1
        and (${conditions.join(' or ')})
      order by created_at asc`,
    [campaignId]
  );
  return rows;
}

/**
 * Conta contatos por categoria — usado pelos botões de exportação.
 */
export async function countByExportCategory(campaignId) {
  const { rows } = await query(
    `select
        sum(case when validation_status = 'invalid'   then 1 else 0 end)::int as invalid,
        sum(case when validation_status = 'duplicate' then 1 else 0 end)::int as duplicate,
        sum(case when send_status = 'failed'          then 1 else 0 end)::int as failed,
        sum(case when send_status = 'failed'
                  and failure_reason = 'not_on_whatsapp' then 1 else 0 end)::int as not_on_whatsapp,
        sum(case when send_status = 'sent'            then 1 else 0 end)::int as sent
      from whatsapp_campaign_contacts
      where campaign_id = $1`,
    [campaignId]
  );
  return rows[0] || { invalid: 0, duplicate: 0, failed: 0, not_on_whatsapp: 0, sent: 0 };
}

export async function cancelPending(campaignId, client) {
  const exec = client ? client.query.bind(client) : query;
  const { rowCount } = await exec(
    `update whatsapp_campaign_contacts
       set send_status = 'cancelled'
       where campaign_id = $1
         and send_status in ('pending','queued')`,
    [campaignId]
  );
  return rowCount;
}
