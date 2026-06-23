import { query } from '../db/client.js';

// Cópias locais das funções de normalização para evitar dependência circular
// com datacrazyClient.js (que importa este repositório).
function _normalizeEmail(v) {
  const s = String(v ?? '').trim().toLowerCase();
  if (s.length < 6 || !s.includes('@')) return '';
  const [local, domain] = s.split('@');
  return local && domain && domain.includes('.') ? s : '';
}

function _normalizePhone(lead) {
  return String(lead?.rawPhone || lead?.phone || '')
    .replace(/\D/g, '')
    .replace(/^55/, '');
}

/**
 * Normaliza CPF: remove não-dígitos e valida 11 dígitos.
 * Retorna string de 11 dígitos ou '' se inválido.
 * @param {unknown} v
 * @returns {string}
 */
function normalizeCpf(v) {
  const d = String(v ?? '').replace(/\D/g, '');
  return d.length === 11 ? d : '';
}

/**
 * Busca entrada no cache por CPF.
 * @param {string} cpf
 * @returns {Promise<{ datacrazy_lead_id: string, email_norm: string|null, phone_norm: string|null, nome: string|null, raw_lead: object|null, last_synced_at: Date }|null>}
 */
export async function getByCpf(cpf) {
  const c = normalizeCpf(cpf);
  if (!c) return null;
  const { rows } = await query(
    `select cpf, datacrazy_lead_id, email_norm, phone_norm, nome, raw_lead, last_synced_at, last_seen_at
       from datacrazy_lead_cache
      where cpf = $1`,
    [c]
  );
  return rows[0] ?? null;
}

/**
 * Busca múltiplos CPFs em uma única query.
 * @param {string[]} cpfs
 * @returns {Promise<Map<string, object>>}
 */
export async function getByCpfBatch(cpfs) {
  const normalized = [...new Set(cpfs.map(normalizeCpf).filter(Boolean))];
  if (!normalized.length) return new Map();
  const { rows } = await query(
    `select cpf, datacrazy_lead_id, email_norm, phone_norm, nome, raw_lead, last_synced_at, last_seen_at
       from datacrazy_lead_cache
      where cpf = any($1::text[])`,
    [normalized]
  );
  return new Map(rows.map((r) => [r.cpf, r]));
}

/**
 * Busca múltiplos e-mails normalizados em uma query.
 * @param {string[]} emails
 * @returns {Promise<Map<string, object>>} chave = email_norm
 */
export async function getByEmailBatch(emails) {
  const normalized = [...new Set(emails.map(_normalizeEmail).filter(Boolean))];
  if (!normalized.length) return new Map();
  const { rows } = await query(
    `select cpf, datacrazy_lead_id, email_norm, phone_norm, nome, raw_lead, last_synced_at, last_seen_at
       from datacrazy_lead_cache
      where email_norm = any($1::text[])`,
    [normalized]
  );
  return new Map(rows.map((r) => [r.email_norm, r]));
}

/**
 * Fallback: busca por e-mail normalizado (quando não há CPF).
 * @param {string} email
 * @returns {Promise<object|null>}
 */
export async function getByEmailNorm(email) {
  const e = _normalizeEmail(email);
  if (!e) return null;
  const { rows } = await query(
    `select cpf, datacrazy_lead_id, email_norm, phone_norm, nome, raw_lead, last_synced_at, last_seen_at
       from datacrazy_lead_cache
      where email_norm = $1
      limit 1`,
    [e]
  );
  return rows[0] ?? null;
}

/**
 * Fallback: busca por telefone normalizado (quando não há CPF).
 * @param {string} phone
 * @returns {Promise<object|null>}
 */
export async function getByPhoneNorm(phone) {
  const p = String(phone ?? '').replace(/\D/g, '').replace(/^55/, '');
  if (!p) return null;
  const { rows } = await query(
    `select cpf, datacrazy_lead_id, email_norm, phone_norm, nome, raw_lead, last_synced_at, last_seen_at
       from datacrazy_lead_cache
      where phone_norm = $1
      limit 1`,
    [p]
  );
  return rows[0] ?? null;
}

/**
 * UPSERT de um único lead. Não atualiza `source` nem `last_seen_at` no conflito.
 * @param {object} lead  – objeto lead vindo da API DataCrazy (taxId, email, rawPhone/phone, name)
 * @param {string} [source]
 * @returns {Promise<boolean>}  true se havia dados pra persistir
 */
export async function upsertLeadFromCrm(lead, source = 'preflight') {
  const cpf = normalizeCpf(lead?.taxId);
  if (!cpf) return false;
  const leadId = String(lead?.id ?? '').trim();
  if (!leadId) return false;
  const email_norm = _normalizeEmail(lead?.email) || null;
  const phone_norm = _normalizePhone(lead) || null;
  const nome = String(lead?.name ?? '').slice(0, 200) || null;
  await query(
    `insert into datacrazy_lead_cache
       (cpf, datacrazy_lead_id, email_norm, phone_norm, nome, raw_lead, source)
     values ($1, $2, $3, $4, $5, $6::jsonb, $7)
     on conflict (cpf) do update set
       datacrazy_lead_id = excluded.datacrazy_lead_id,
       email_norm        = excluded.email_norm,
       phone_norm        = excluded.phone_norm,
       nome              = excluded.nome,
       raw_lead          = excluded.raw_lead,
       last_synced_at    = now()`,
    [cpf, leadId, email_norm, phone_norm, nome, JSON.stringify(lead), source]
  );
  return true;
}

/**
 * UPSERT em lote (1 round-trip por chunk de 500 leads).
 * Leads com CPF inválido/ausente são ignorados silenciosamente.
 * @param {object[]} leads
 * @param {string} [source]
 * @returns {Promise<number>}  quantidade de rows upsertadas
 */
export async function upsertLeadFromCrmBatch(leads, source = 'preflight') {
  // Dedup por CPF dentro do batch (Postgres recusa ON CONFLICT quando a mesma
  // chave aparece 2x no mesmo INSERT). A API DataCrazy às vezes retorna o
  // mesmo CPF em múltiplos leads (registros duplicados na base CRM).
  // Mantém a última ocorrência (Map preserva ordem de inserção).
  const byCpf = new Map();
  for (const lead of leads) {
    const cpf = normalizeCpf(lead?.taxId);
    if (!cpf) continue;
    const leadId = String(lead?.id ?? '').trim();
    if (!leadId) continue;
    byCpf.set(cpf, {
      cpf,
      leadId,
      email_norm: _normalizeEmail(lead?.email) || null,
      phone_norm: _normalizePhone(lead) || null,
      nome: String(lead?.name ?? '').slice(0, 200) || null,
      raw: JSON.stringify(lead),
    });
  }
  const valid = [...byCpf.values()];
  if (!valid.length) return 0;

  const CHUNK = 500;
  let total = 0;
  for (let i = 0; i < valid.length; i += CHUNK) {
    const chunk = valid.slice(i, i + CHUNK);
    const cpfs      = chunk.map((r) => r.cpf);
    const leadIds   = chunk.map((r) => r.leadId);
    const emails    = chunk.map((r) => r.email_norm);
    const phones    = chunk.map((r) => r.phone_norm);
    const names     = chunk.map((r) => r.nome);
    const raws      = chunk.map((r) => r.raw);
    const sources   = chunk.map(() => source);

    await query(
      `insert into datacrazy_lead_cache
         (cpf, datacrazy_lead_id, email_norm, phone_norm, nome, raw_lead, source)
       select cpf, lead_id, em, ph, nm, raw::jsonb, src
         from unnest(
           $1::text[], $2::text[], $3::text[], $4::text[], $5::text[], $6::text[], $7::text[]
         ) as t(cpf, lead_id, em, ph, nm, raw, src)
       on conflict (cpf) do update set
         datacrazy_lead_id = excluded.datacrazy_lead_id,
         email_norm        = excluded.email_norm,
         phone_norm        = excluded.phone_norm,
         nome              = excluded.nome,
         raw_lead          = excluded.raw_lead,
         last_synced_at    = now()`,
      [cpfs, leadIds, emails, phones, names, raws, sources]
    );
    total += chunk.length;
  }
  return total;
}

/**
 * Atualiza `last_seen_at` para indicar que esses CPFs foram vistos num disparo.
 * Fire-and-forget: não bloqueia o disparo.
 * @param {string[]} cpfs
 * @returns {Promise<void>}
 */
export async function touchLastSeen(cpfs) {
  const normalized = cpfs.map(normalizeCpf).filter(Boolean);
  if (!normalized.length) return;
  await query(
    `update datacrazy_lead_cache
        set last_seen_at = now()
      where cpf = any($1::text[])`,
    [normalized]
  );
}

/**
 * Registra início de uma rodada de sync no log.
 * @returns {Promise<string>}  id do registro (bigint como string)
 */
export async function recordSyncStart() {
  const { rows } = await query(
    `insert into datacrazy_lead_cache_sync_log (status)
     values ('running')
     returning id`
  );
  return String(rows[0].id);
}

/**
 * Atualiza o registro de sync com resultado final.
 * @param {string} id
 * @param {{ pages: number, leadsSeen: number, upserted: number, skipped: number, status?: string, errorMessage?: string|null }} result
 * @returns {Promise<void>}
 */
export async function recordSyncFinish(
  id,
  { pages, leadsSeen, upserted, skipped, status = 'ok', errorMessage = null }
) {
  await query(
    `update datacrazy_lead_cache_sync_log
        set finished_at    = now(),
            pages_scanned  = $2,
            leads_seen     = $3,
            leads_upserted = $4,
            leads_skipped  = $5,
            status         = $6,
            error_message  = $7
      where id = $1`,
    [id, pages, leadsSeen, upserted, skipped, status, errorMessage ?? null]
  );
}

/**
 * Estatísticas do cache + último sync (para UI e polling).
 */
export async function getCacheStats() {
  const { rows: countRows } = await query(
    `select count(*)::int as cache_count from datacrazy_lead_cache`
  );
  const { rows: lastRows } = await query(
    `select id, started_at, finished_at, pages_scanned, leads_seen, leads_upserted,
            leads_skipped, status, error_message
       from datacrazy_lead_cache_sync_log
      order by started_at desc
      limit 1`
  );
  const { rows: runningRows } = await query(
    `select id, started_at
       from datacrazy_lead_cache_sync_log
      where status = 'running'
        and finished_at is null
        and started_at > now() - interval '4 hours'
      order by started_at desc
      limit 1`
  );
  return {
    cache_count: countRows[0]?.cache_count ?? 0,
    last_sync: lastRows[0] ?? null,
    running: runningRows[0] ?? null,
  };
}

/**
 * @returns {Promise<boolean>} true se havia sync órfão e foi fechado
 */
export async function closeStaleRunningSyncs() {
  const { rowCount } = await query(
    `update datacrazy_lead_cache_sync_log
        set status = 'error',
            finished_at = now(),
            error_message = 'sync interrompido (timeout ou restart do servidor)'
      where status = 'running'
        and finished_at is null
        and started_at < now() - interval '4 hours'`
  );
  return (rowCount ?? 0) > 0;
}
