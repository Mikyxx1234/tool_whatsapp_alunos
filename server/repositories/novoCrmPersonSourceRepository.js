import { novoCrmQuery } from '../db/novoCrmClient.js';
import {
  hashObject,
  normalizeCpf,
  normalizeEmail,
  normalizePhone,
  normalizeRgm,
  collectFilledBusinessPaths,
} from '../utils/novoCrmCacheNormalize.js';

function toIso(value) {
  return value ? new Date(value).toISOString() : null;
}

function customValue(row) {
  const raw = row?.value;
  if (raw == null) return null;
  if (typeof raw === 'object') {
    if (raw.value != null && (typeof raw.value === 'string' || typeof raw.value === 'number')) {
      return String(raw.value);
    }
    // jsonb stringified scalar already handled; ignore nested objects for lookup fields
    return null;
  }
  return String(raw);
}

function fieldName(row) {
  return String(row?.field_name || row?.customFieldId || row?.custom_field_id || '').trim();
}

function findCustomValue(deal, wantedNames) {
  const wanted = wantedNames.map((v) => String(v).trim().toLowerCase());
  for (const field of deal.customFields || []) {
    const name = String(field.name || '').trim().toLowerCase();
    if (wanted.includes(name)) return field.value;
  }
  return null;
}

function pickPrimaryDeal(deals) {
  if (!deals.length) return null;
  const sorted = deals.slice().sort((a, b) => {
    const ao = String(a.status || '').toUpperCase() === 'OPEN' ? 1 : 0;
    const bo = String(b.status || '').toUpperCase() === 'OPEN' ? 1 : 0;
    if (ao !== bo) return bo - ao;
    return String(b.updatedAt || b.createdAt || '').localeCompare(String(a.updatedAt || a.createdAt || ''));
  });
  return sorted[0] || null;
}

function maxDate(values) {
  const dates = values.filter(Boolean).map((v) => new Date(v).getTime()).filter(Number.isFinite);
  if (!dates.length) return null;
  return new Date(Math.max(...dates)).toISOString();
}

function mapSnapshot(contact, dealRows, customRows) {
  const customByDeal = new Map();
  for (const row of customRows) {
    const dealId = String(row.deal_id);
    const arr = customByDeal.get(dealId) || [];
    arr.push({
      id: row.custom_field_id ? String(row.custom_field_id) : null,
      name: fieldName(row),
      value: customValue(row),
    });
    customByDeal.set(dealId, arr);
  }

  const deals = dealRows
    .map((d) => ({
      id: String(d.id),
      number: d.number != null ? String(d.number) : null,
      title: d.title || null,
      status: d.status != null ? String(d.status) : null,
      ownerId: d.owner_id || null,
      ownerName: d.owner_name || null,
      ownerEmail: d.owner_email || null,
      createdAt: toIso(d.created_at),
      updatedAt: toIso(d.updated_at),
      customFields: customByDeal.get(String(d.id)) || [],
    }))
    .sort((a, b) => String(b.updatedAt || '').localeCompare(String(a.updatedAt || '')));

  const primaryDeal = pickPrimaryDeal(deals);
  const orderedForCustom = primaryDeal
    ? [primaryDeal, ...deals.filter((d) => d.id !== primaryDeal.id)]
    : deals;
  let cpf = null;
  let rgm = null;
  for (const deal of orderedForCustom) {
    if (!cpf) cpf = findCustomValue(deal, ['cpf', 'documento', 'taxid']);
    if (!rgm) rgm = findCustomValue(deal, ['rgm']);
    if (cpf && rgm) break;
  }

  const rawData = {
    contact: {
      id: String(contact.id),
      number: contact.number != null ? String(contact.number) : null,
      name: contact.name || null,
      email: contact.email || null,
      phone: contact.phone || null,
      assignedToId: contact.assigned_to_id || null,
      assignedName: contact.assigned_name || null,
      assignedEmail: contact.assigned_email || null,
      createdAt: toIso(contact.created_at),
      updatedAt: toIso(contact.updated_at),
    },
    primaryDealId: primaryDeal?.id || null,
    dealsById: Object.fromEntries(deals.map((d) => [String(d.id), d])),
  };

  const filled = collectFilledBusinessPaths(rawData);
  const sourceUpdatedAt = maxDate([
    contact.updated_at,
    contact.created_at,
    ...deals.flatMap((d) => [d.updatedAt, d.createdAt]),
  ]);

  return {
    contactId: String(contact.id),
    primaryDealId: primaryDeal?.id || null,
    contactNumber: contact.number != null ? String(contact.number) : null,
    nome: contact.name || null,
    phoneNorm: normalizePhone(contact.phone) || null,
    emailNorm: normalizeEmail(contact.email) || null,
    cpfNorm: normalizeCpf(cpf) || null,
    rgmNorm: normalizeRgm(rgm) || null,
    rawData,
    filledFieldCount: filled.size,
    contentHash: hashObject(rawData),
    sourceUpdatedAt,
  };
}

export async function countAllContacts() {
  const { rows } = await novoCrmQuery(`select count(*)::int as total from contacts`);
  return rows[0]?.total ?? 0;
}

export async function listFullContactIdsPage({ afterId = null, limit = 300 } = {}) {
  const params = [Math.min(Math.max(Number(limit) || 300, 1), 1000)];
  let where = '';
  if (afterId) {
    params.push(String(afterId));
    where = `where c.id::text > $${params.length}`;
  }
  const { rows } = await novoCrmQuery(
    `select c.id::text as id
       from contacts c
       ${where}
      order by c.id::text
      limit $1`,
    params
  );
  return rows.map((r) => String(r.id));
}

export async function listUpdatedContactIdsSince(
  since,
  { afterUpdatedAt = null, afterId = null, limit = 300 } = {}
) {
  const { rows } = await novoCrmQuery(
    `with impacted as (
       select c.id::text as id, c."updatedAt" as updated_at
         from contacts c
        where c."updatedAt" >= $1::timestamptz
       union
       select d."contactId"::text as id, d."updatedAt" as updated_at
         from deals d
        where d."updatedAt" >= $1::timestamptz
          and d."contactId" is not null
     )
     select id, max(updated_at) as updated_at
       from impacted
      group by id
     having (
       $2::timestamptz is null
       or max(updated_at) > $2::timestamptz
       or (max(updated_at) = $2::timestamptz and id > coalesce($3::text, ''))
     )
      order by max(updated_at), id
      limit $4`,
    [since, afterUpdatedAt, afterId, Math.min(Math.max(Number(limit) || 300, 1), 1000)]
  );
  return rows.map((r) => ({
    id: String(r.id),
    updatedAt: r.updated_at ? new Date(r.updated_at).toISOString() : null,
  }));
}

export async function loadSnapshotsByContactIds(contactIds) {
  const ids = [...new Set((contactIds || []).map(String).filter(Boolean))];
  if (!ids.length) return [];

  const [{ rows: contacts }, { rows: deals }, { rows: customRows }] = await Promise.all([
    novoCrmQuery(
      `select c.id::text as id, c.number, c.name, c.email, c.phone,
              c."assignedToId"::text as assigned_to_id,
              c."createdAt" as created_at, c."updatedAt" as updated_at,
              au.name as assigned_name, au.email as assigned_email
         from contacts c
         left join users au on au.id = c."assignedToId"
        where c.id::text = any($1::text[])`,
      [ids]
    ),
    novoCrmQuery(
      `select d.id::text as id, d."contactId"::text as contact_id, d.number, d.title,
              d.status::text as status, d."ownerId"::text as owner_id,
              d."createdAt" as created_at, d."updatedAt" as updated_at,
              ou.name as owner_name, ou.email as owner_email
         from deals d
         left join users ou on ou.id = d."ownerId"
        where d."contactId"::text = any($1::text[])`,
      [ids]
    ),
    novoCrmQuery(
      `select v."dealId"::text as deal_id,
              v."customFieldId"::text as custom_field_id,
              cf.name as field_name,
              v.value
         from deal_custom_field_values v
         left join custom_fields cf on cf.id = v."customFieldId"
        where v."dealId" in (
          select d.id from deals d where d."contactId"::text = any($1::text[])
        )`,
      [ids]
    ),
  ]);

  const dealsByContact = new Map();
  for (const d of deals) {
    const arr = dealsByContact.get(String(d.contact_id)) || [];
    arr.push(d);
    dealsByContact.set(String(d.contact_id), arr);
  }

  const customsByDeal = new Map();
  for (const row of customRows) {
    const dealId = String(row.deal_id);
    const arr = customsByDeal.get(dealId) || [];
    arr.push(row);
    customsByDeal.set(dealId, arr);
  }

  return contacts.map((c) => {
    const contactDeals = dealsByContact.get(String(c.id)) || [];
    const customs = [];
    for (const d of contactDeals) {
      const rows = customsByDeal.get(String(d.id));
      if (rows?.length) customs.push(...rows);
    }
    return mapSnapshot(c, contactDeals, customs);
  });
}

export async function findContactIdsByLookup({ phones = [], emails = [], cpfs = [], rgms = [] } = {}) {
  const phoneKeys = [...new Set(phones.map(normalizePhone).filter(Boolean))];
  const emailKeys = [...new Set(emails.map(normalizeEmail).filter(Boolean))];
  const cpfKeys = [...new Set(cpfs.map(normalizeCpf).filter(Boolean))];
  const rgmKeys = [...new Set(rgms.map(normalizeRgm).filter(Boolean))];
  if (!phoneKeys.length && !emailKeys.length && !cpfKeys.length && !rgmKeys.length) return [];

  const { rows } = await novoCrmQuery(
    `with contact_hits as (
       select c.id::text as contact_id
         from contacts c
        where (
          cardinality($1::text[]) > 0
          and regexp_replace(regexp_replace(coalesce(c.phone, ''), '\\D', '', 'g'), '^55', '') = any($1::text[])
        )
        or (
          cardinality($2::text[]) > 0
          and lower(trim(coalesce(c.email, ''))) = any($2::text[])
        )
     ),
     custom_hits as (
       select distinct d."contactId"::text as contact_id
         from deal_custom_field_values v
         join custom_fields cf on cf.id = v."customFieldId"
         join deals d on d.id = v."dealId"
        where d."contactId" is not null
          and (
            (
              cardinality($3::text[]) > 0
              and lower(cf.name) in ('cpf', 'documento', 'taxid')
              and regexp_replace(coalesce(v.value::text, ''), '\\D', '', 'g') = any($3::text[])
            )
            or (
              cardinality($4::text[]) > 0
              and lower(cf.name) = 'rgm'
              and regexp_replace(coalesce(v.value::text, ''), '\\D', '', 'g') = any($4::text[])
            )
          )
     )
     select distinct contact_id
       from (
         select contact_id from contact_hits
         union all
         select contact_id from custom_hits
       ) x
      limit 5000`,
    [phoneKeys, emailKeys, cpfKeys, rgmKeys]
  );
  return rows.map((r) => String(r.contact_id));
}
