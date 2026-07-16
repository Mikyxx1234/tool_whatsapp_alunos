import { novoCrmQuery } from '../db/novoCrmClient.js';
import {
  isRetencaoQuestion,
  normalizeTabulationQuestion,
  retentionOutcomeFromAnswer,
  retencaoQuestionPattern,
} from '../utils/novoCrmRetencao.js';

/**
 * SQL fragment: question bate com retenção (case-insensitive, ? opcional).
 * Usa $idx como padrão base (ex: 'Retido?').
 */
function retencaoQuestionSql(paramIdx) {
  return `(
    regexp_replace(lower(trim(t.question)), '\\?+$', '') =
    regexp_replace(lower(trim($${paramIdx})), '\\?+$', '')
  )`;
}

/**
 * Última tabulação de retenção por contactId (DISTINCT ON).
 * @param {{ from?: string|null, to?: string|null, contactIds?: string[]|null }} [opts]
 */
export async function listLatestRetencaoByContact(opts = {}) {
  const params = [];
  const where = [retencaoQuestionSql(1)];
  params.push(retencaoQuestionPattern());

  if (opts.from) {
    params.push(opts.from);
    where.push(`t."closedAt" >= $${params.length}::date`);
  }
  if (opts.to) {
    params.push(opts.to);
    where.push(`t."closedAt" < ($${params.length}::date + interval '1 day')`);
  }
  if (Array.isArray(opts.contactIds) && opts.contactIds.length > 0) {
    params.push(opts.contactIds);
    where.push(`t."contactId" = any($${params.length}::text[])`);
  }

  const { rows } = await novoCrmQuery(
    `select distinct on (t."contactId")
       t.id, t."conversationId", t."contactId", t."dealId", t."stageId", t."stageName",
       t.question, t.answer, t."closedByUserId", t."closedAt"
     from conversation_close_tabulations t
     where ${where.join(' and ')}
     order by t."contactId", t."closedAt" desc`,
    params
  );

  return rows.map(mapRow);
}

/**
 * Contatos com tabulação de retenção no período (mesmo sem filtro de closedAt na lista completa).
 * @param {{ from?: string|null, to?: string|null }} [opts]
 */
export async function listRetencaoContactIdsInPeriod(opts = {}) {
  const params = [retencaoQuestionPattern()];
  const where = [retencaoQuestionSql(1)];
  if (opts.from) {
    params.push(opts.from);
    where.push(`t."closedAt" >= $${params.length}::date`);
  }
  if (opts.to) {
    params.push(opts.to);
    where.push(`t."closedAt" < ($${params.length}::date + interval '1 day')`);
  }
  const { rows } = await novoCrmQuery(
    `select distinct t."contactId" as contact_id
       from conversation_close_tabulations t
      where ${where.join(' and ')}`,
    params
  );
  return rows.map((r) => String(r.contact_id));
}

/**
 * Destinatários de campanha que responderam no período.
 * @param {{ from?: string|null, to?: string|null }} [opts]
 */
export async function listCampaignReplyContactIds(opts = {}) {
  const params = [];
  const where = [`r."repliedAt" is not null`];
  if (opts.from) {
    params.push(opts.from);
    where.push(`r."repliedAt" >= $${params.length}::date`);
  }
  if (opts.to) {
    params.push(opts.to);
    where.push(`r."repliedAt" < ($${params.length}::date + interval '1 day')`);
  }
  const { rows } = await novoCrmQuery(
    `select distinct r."contactId" as contact_id, max(r."repliedAt") as replied_at
       from campaign_recipients r
      where ${where.join(' and ')}
      group by r."contactId"`,
    params
  );
  return rows.map((r) => ({
    contactId: String(r.contact_id),
    repliedAt: r.replied_at ? new Date(r.replied_at).toISOString() : null,
  }));
}

/**
 * Enriquece contacts + deal (RGM/CPF) + users.
 * @param {string[]} contactIds
 */
export async function enrichContacts(contactIds) {
  const ids = [...new Set((contactIds || []).map(String).filter(Boolean))];
  if (!ids.length) return new Map();

  const { rows: contacts } = await novoCrmQuery(
    `select c.id, c.name, c.email, c.phone, c.number as contact_number, c."assignedToId",
            au.name as assigned_name, au.email as assigned_email
       from contacts c
       left join users au on au.id = c."assignedToId"
      where c.id = any($1::text[])`,
    [ids]
  );

  const { rows: deals } = await novoCrmQuery(
    `select distinct on (d."contactId")
       d.id as deal_id, d."contactId" as contact_id, d.title, d.number as deal_number,
       d.status::text as deal_status, d."ownerId",
       ou.name as owner_name, ou.email as owner_email,
       (select v.value from deal_custom_field_values v
          join custom_fields cf on cf.id = v."customFieldId"
         where v."dealId" = d.id and lower(cf.name) = 'rgm'
         limit 1) as rgm,
       (select v.value from deal_custom_field_values v
          join custom_fields cf on cf.id = v."customFieldId"
         where v."dealId" = d.id and lower(cf.name) = 'cpf'
         limit 1) as cpf,
       (select v.value from deal_custom_field_values v
          join custom_fields cf on cf.id = v."customFieldId"
         where v."dealId" = d.id and lower(cf.name) in ('curso','course')
         limit 1) as curso,
       (select v.value from deal_custom_field_values v
          join custom_fields cf on cf.id = v."customFieldId"
         where v."dealId" = d.id and lower(cf.name) = 'polo'
         limit 1) as polo
     from deals d
     left join users ou on ou.id = d."ownerId"
     where d."contactId" = any($1::text[])
     order by d."contactId", d."updatedAt" desc nulls last`,
    [ids]
  );

  const dealByContact = new Map(deals.map((d) => [String(d.contact_id), d]));
  const map = new Map();
  for (const c of contacts) {
    const deal = dealByContact.get(String(c.id));
    map.set(String(c.id), {
      contactId: String(c.id),
      contactNumber: c.contact_number != null ? String(c.contact_number) : null,
      nome: c.name || null,
      email: c.email || null,
      telefone: c.phone || null,
      assignedToId: c.assignedToId || null,
      assignedName: c.assigned_name || null,
      dealId: deal?.deal_id || null,
      dealNumber: deal?.deal_number != null ? String(deal.deal_number) : null,
      dealStatus: deal?.deal_status || null,
      dealTitle: deal?.title || null,
      ownerId: deal?.ownerId || deal?.owner_id || null,
      ownerName: deal?.owner_name || null,
      ownerEmail: deal?.owner_email || null,
      rgm: deal?.rgm || null,
      cpf: deal?.cpf || null,
      curso: deal?.curso || null,
      polo: deal?.polo || null,
    });
  }
  return map;
}

/**
 * @param {string[]} userIds
 * @returns {Promise<Map<string, { id: string, name: string|null, email: string|null }>>}
 */
export async function loadUsersById(userIds) {
  const ids = [...new Set((userIds || []).map(String).filter(Boolean))];
  if (!ids.length) return new Map();
  const { rows } = await novoCrmQuery(
    `select id, name, email from users where id = any($1::text[])`,
    [ids]
  );
  return new Map(
    rows.map((u) => [
      String(u.id),
      { id: String(u.id), name: u.name || null, email: u.email || null },
    ])
  );
}

function mapRow(r) {
  const answer = r.answer;
  const outcome = isRetencaoQuestion(r.question)
    ? retentionOutcomeFromAnswer(answer)
    : null;
  return {
    id: String(r.id),
    conversationId: r.conversationId || r.conversation_id || null,
    contactId: String(r.contactId || r.contact_id),
    dealId: r.dealId || r.deal_id || null,
    stageId: r.stageId || r.stage_id || null,
    stageName: r.stageName || r.stage_name || null,
    question: r.question,
    answer,
    closedByUserId: r.closedByUserId || r.closed_by_user_id || null,
    closedAt: r.closedAt || r.closed_at
      ? new Date(r.closedAt || r.closed_at).toISOString()
      : null,
    retentionOutcome: outcome,
    questionNormalized: normalizeTabulationQuestion(r.question),
  };
}
