import { query } from '../db/client.js';

const FIELDS = `
  id, campaign_type_id, name, description,
  template_name, template_language, template_category,
  source_file_name,
  total_contacts, total_valid, total_invalid, total_duplicates,
  total_sent, total_failed, total_interacted, total_not_interacted,
  status, interval_seconds, daily_limit,
  started_at, finished_at, created_at, updated_at, created_by
`;

export async function create(data, client) {
  const exec = client ? client.query.bind(client) : query;
  const { rows } = await exec(
    `insert into whatsapp_campaigns
       (campaign_type_id, name, description, template_name, template_language,
        template_category, source_file_name, interval_seconds, daily_limit,
        status, created_by)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
     returning ${FIELDS}`,
    [
      data.campaignTypeId,
      data.name,
      data.description || null,
      data.templateName || null,
      data.templateLanguage || 'pt_BR',
      data.templateCategory || null,
      data.sourceFileName || null,
      data.intervalSeconds ?? 5,
      data.dailyLimit ?? null,
      data.status || 'draft',
      data.createdBy || null,
    ]
  );
  return rows[0];
}

export async function findById(id, client) {
  const exec = client ? client.query.bind(client) : query;
  const { rows } = await exec(
    `select ${FIELDS} from whatsapp_campaigns where id = $1 limit 1`,
    [id]
  );
  return rows[0] || null;
}

export async function listSummary({ limit = 50, offset = 0, status, typeCode } = {}) {
  const params = [];
  const where = [];
  if (status) {
    params.push(status);
    where.push(`status = $${params.length}`);
  }
  if (typeCode) {
    params.push(typeCode);
    where.push(`campaign_type = $${params.length}`);
  }
  params.push(limit);
  params.push(offset);
  const whereSql = where.length ? `where ${where.join(' and ')}` : '';
  const { rows } = await query(
    `select * from vw_whatsapp_campaign_summary
       ${whereSql}
       order by created_at desc
       limit $${params.length - 1} offset $${params.length}`,
    params
  );
  return rows;
}

export async function findSummaryById(id) {
  const { rows } = await query(
    `select * from vw_whatsapp_campaign_summary where id = $1 limit 1`,
    [id]
  );
  return rows[0] || null;
}

export async function updateStatus(id, status, extras = {}, client) {
  const exec = client ? client.query.bind(client) : query;

  const setClauses = ['status = $1'];
  const params = [status];

  for (const [key, value] of Object.entries(extras)) {
    params.push(value);
    setClauses.push(`${key} = $${params.length}`);
  }

  params.push(id);
  const { rows } = await exec(
    `update whatsapp_campaigns
       set ${setClauses.join(', ')}
       where id = $${params.length}
       returning ${FIELDS}`,
    params
  );
  return rows[0] || null;
}

export async function refreshTotalsFromContacts(campaignId, client) {
  const exec = client ? client.query.bind(client) : query;
  await exec(
    `update whatsapp_campaigns c set
       total_contacts        = sub.c_total,
       total_valid           = sub.c_valid,
       total_invalid         = sub.c_invalid,
       total_duplicates      = sub.c_duplicates,
       total_sent            = sub.c_sent,
       total_failed          = sub.c_failed,
       total_interacted      = sub.c_interacted,
       total_not_interacted  = sub.c_not_interacted
     from (
       select
         count(*)                                                   as c_total,
         count(*) filter (where validation_status = 'valid')        as c_valid,
         count(*) filter (where validation_status = 'invalid')      as c_invalid,
         count(*) filter (where validation_status = 'duplicate')    as c_duplicates,
         count(*) filter (where send_status       = 'sent')         as c_sent,
         count(*) filter (where send_status       = 'failed')       as c_failed,
         count(*) filter (where interaction_status = 'interacted')  as c_interacted,
         count(*) filter (where interaction_status = 'not_interacted') as c_not_interacted
       from whatsapp_campaign_contacts
       where campaign_id = $1
     ) sub
     where c.id = $1`,
    [campaignId]
  );
  return findById(campaignId, client);
}

export async function incrementCounter(campaignId, column, by = 1, client) {
  const allowed = new Set([
    'total_sent',
    'total_failed',
    'total_interacted',
    'total_not_interacted',
  ]);
  if (!allowed.has(column)) {
    throw new Error(`Coluna não permitida: ${column}`);
  }
  const exec = client ? client.query.bind(client) : query;
  await exec(
    `update whatsapp_campaigns set ${column} = ${column} + $1 where id = $2`,
    [by, campaignId]
  );
}
