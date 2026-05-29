import { query } from '../db/client.js';
import { masterKeyFromParts } from '../utils/activationIdentity.js';
import { normalizeBrazilianPhone } from '../utils/phoneNormalizer.js';
import { normalizeRgmCanonical } from '../utils/rgmDisplay.js';
import { excelSerialToDate, parseFlexibleDate } from '../utils/dateParser.js';

/**
 * @typedef {Object} ActivationResponseRow
 * @property {string} id
 * @property {string|null} category
 * @property {string|null} master_key
 * @property {string|null} datacrazy_lead_id
 * @property {string|null} telefone
 * @property {string|null} rgm
 * @property {'click'|'message'|'opt_out'|'other'} response_kind
 * @property {string|null} button_payload
 * @property {string|null} message_text
 * @property {string|null} external_id
 * @property {Record<string, unknown>|null} raw_payload
 * @property {string} received_at
 * @property {string} created_at
 */

function normalizePhoneOrRaw(input) {
  if (!input) return null;
  const n = normalizeBrazilianPhone(input);
  return n.ok ? n.phone : String(input).replace(/\D+/g, '') || null;
}

function normalizeCpfDigits(input) {
  const d = String(input ?? '').replace(/\D/g, '');
  return d.length === 11 ? d : '';
}

function matriculaDateFromRow(data) {
  if (!data || typeof data !== 'object') return null;
  const raw =
    data['Data Matrícula'] ??
    data['Data Matricula'] ??
    data['Data matrícula'] ??
    data['Data matricula'] ??
    null;
  return parseFlexibleDate(raw) || excelSerialToDate(raw);
}

/**
 * Último snapshot matriculados: acha RGM pelo CPF (11 dígitos), matrícula mais recente.
 * @param {string} cpfDigits
 * @returns {Promise<string|null>}
 */
export async function findRgmByCpfInMatriculados(cpfDigits) {
  if (cpfDigits.length !== 11) return null;
  const { rows } = await query(
    `select data
       from matriculados_rows
      where snapshot_id = (
        select id from matriculados_snapshots order by created_at desc limit 1
      )
        and regexp_replace(
          coalesce(data->>'CPF', data->>'Cpf', data->>'Cpf Aluno', ''),
          '[^0-9]', '', 'g'
        ) = $1`,
    [cpfDigits]
  );
  let bestRgm = null;
  let bestDate = null;
  for (const r of rows) {
    const row = r?.data;
    if (!row || typeof row !== 'object') continue;
    const rgm = normalizeRgmCanonical(row.RGM ?? row.Rgm ?? row.Matricula ?? row.matricula);
    if (!rgm) continue;
    const matDate = matriculaDateFromRow(row);
    if (!bestDate || (matDate && matDate > bestDate)) {
      bestDate = matDate;
      bestRgm = rgm;
    } else if (!bestDate && !bestRgm) {
      bestRgm = rgm;
    }
  }
  return bestRgm;
}

/**
 * Insere uma resposta (idempotente via external_id).
 * Quando master_key/lead_id/phone faltam, tenta resolver pelo último dispatch.
 *
 * @param {{
 *   category?: string|null,
 *   masterKey?: string|null,
 *   datacrazyLeadId?: string|null,
 *   telefone?: string|null,
 *   rgm?: string|null,
 *   cpf?: string|null,
 *   responseKind?: 'click'|'message'|'opt_out'|'other',
 *   buttonPayload?: string|null,
 *   messageText?: string|null,
 *   externalId?: string|null,
 *   rawPayload?: Record<string, unknown>|null,
 *   receivedAt?: Date|string|null,
 * }} input
 */
export async function recordResponse(input) {
  const telNorm = normalizePhoneOrRaw(input.telefone);
  const cpfDigits = normalizeCpfDigits(input.cpf);

  // Matriculados é fonte de verdade do RGM quando há CPF (matrícula mais recente).
  let rgm = null;
  if (cpfDigits) {
    rgm = await findRgmByCpfInMatriculados(cpfDigits);
  }
  if (!rgm && input.rgm) {
    rgm = normalizeRgmCanonical(input.rgm);
  }

  let category = input.category ?? null;
  let masterKey = input.masterKey ?? null;
  if (!masterKey) {
    masterKey = masterKeyFromParts({
      rgm,
      cpf: cpfDigits || input.cpf,
      telefone: telNorm,
    });
  }
  if (!masterKey) {
    const resolved = await resolveDispatchContext({
      category,
      datacrazyLeadId: input.datacrazyLeadId ?? null,
      telefone: telNorm,
    });
    if (resolved) {
      category = category ?? resolved.category;
      masterKey = resolved.master_key;
      if (!rgm && resolved.rgm) rgm = normalizeRgmCanonical(resolved.rgm);
    }
  }

  const params = [
    category,
    masterKey,
    input.datacrazyLeadId ?? null,
    telNorm,
    rgm,
    input.responseKind ?? 'click',
    input.buttonPayload ?? null,
    input.messageText ?? null,
    input.externalId ?? null,
    input.rawPayload ? JSON.stringify(input.rawPayload) : null,
    input.receivedAt ? new Date(input.receivedAt) : new Date(),
  ];

  const { rows } = await query(
    `insert into activation_responses (
       category, master_key, datacrazy_lead_id, telefone, rgm,
       response_kind, button_payload, message_text, external_id,
       raw_payload, received_at
     ) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb,$11)
     on conflict (external_id) where external_id is not null do nothing
     returning id, category, master_key, datacrazy_lead_id, telefone,
               response_kind, received_at`,
    params
  );
  return rows[0] ?? null;
}

/**
 * Acha o último dispatch que casa com lead_id ou telefone (até 7 dias atrás).
 * Usado quando o gravador da resposta só sabe um dos dois.
 *
 * @param {{ category?: string|null, datacrazyLeadId?: string|null, telefone?: string|null }} q
 * @param {number} [windowHours=168]
 */
export async function resolveDispatchContext(q, windowHours = 168) {
  if (!q.datacrazyLeadId && !q.telefone) return null;

  const params = [windowHours];
  const wheres = [`created_at >= now() - ($1 || ' hours')::interval`, `status = 'sent'`];

  if (q.category) {
    params.push(q.category);
    wheres.push(`category = $${params.length}`);
  }
  const ors = [];
  if (q.datacrazyLeadId) {
    params.push(q.datacrazyLeadId);
    ors.push(`datacrazy_lead_id = $${params.length}`);
  }
  if (q.telefone) {
    const digits = String(q.telefone).replace(/\D/g, '');
    if (digits.length >= 10) {
      params.push(digits);
      ors.push(
        `regexp_replace(coalesce(telefone, ''), '\\D', '', 'g') = $${params.length}`
      );
    }
  }
  if (!ors.length) return null;
  wheres.push(`(${ors.join(' or ')})`);

  const { rows } = await query(
    `select id, category, master_key, datacrazy_lead_id, telefone, rgm, created_at
       from activation_dispatch_events
      where ${wheres.join(' and ')}
      order by created_at desc
      limit 1`,
    params
  );
  return rows[0] ?? null;
}

/**
 * Bulk: pra cada master_key, devolve a última resposta (ou null).
 * Usado pelo roster pra mostrar badge "Interagiu há X".
 *
 * @param {string} category
 * @param {string[]} masterKeys
 */
export async function findLastByMasterKeys(category, masterKeys) {
  const keys = [...new Set(masterKeys.filter(Boolean))];
  if (!keys.length) return new Map();
  const { rows } = await query(
    `select distinct on (master_key)
       master_key, response_kind, button_payload, message_text, received_at
       from activation_responses
      where category = $1 and master_key = any($2::text[])
      order by master_key, received_at desc`,
    [category, keys]
  );
  return new Map(rows.map((r) => [r.master_key, r]));
}

/** Quantidade de respostas recebidas na janela.
 * @param {string} category
 * @param {Date} since
 */
export async function countSince(category, since) {
  const { rows } = await query(
    `select count(*)::int as n,
            count(*) filter (where response_kind = 'click')   ::int as clicks,
            count(*) filter (where response_kind = 'opt_out') ::int as opt_outs
       from activation_responses
      where category = $1 and received_at >= $2`,
    [category, since]
  );
  return rows[0] ?? { n: 0, clicks: 0, opt_outs: 0 };
}

/** Lista paginada para a aba "interagiram" — opcional.
 * @param {string} category
 * @param {{ since?: Date, limit?: number }} [opts]
 */
export async function listByCategory(category, opts = {}) {
  const params = [category];
  const wheres = [`category = $1`];
  if (opts.since) {
    params.push(opts.since);
    wheres.push(`received_at >= $${params.length}`);
  }
  const limit = opts.limit ?? 500;
  params.push(limit);
  const { rows } = await query(
    `select id, master_key, datacrazy_lead_id, telefone, rgm,
            response_kind, button_payload, message_text, received_at
       from activation_responses
      where ${wheres.join(' and ')}
      order by received_at desc
      limit $${params.length}`,
    params
  );
  return rows;
}
