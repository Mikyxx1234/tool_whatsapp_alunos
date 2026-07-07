import { query } from '../db/client.js';
import { masterKeyFromParts } from '../utils/activationIdentity.js';
import { sanitizeCaaConsultorForStorage } from '../utils/caaConsultorAllowlist.js';
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

function consultorFromRawPayload(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const candidates = [
    raw.consultor_responsavel_nome,
    raw.consultorResponsavelNome,
    raw.Consultor,
    raw.consultor,
    raw.responsavel,
    raw.responsible_user_name,
  ];
  for (const c of candidates) {
    if (typeof c === 'string' && c.trim()) return c.trim().slice(0, 200);
  }
  return null;
}

function rgmFromRawPayload(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const rawRgm = raw.RGM ?? raw.rgm ?? null;
  if (rawRgm === null || rawRgm === undefined || String(rawRgm).trim() === '') return null;
  return normalizeRgmCanonical(rawRgm) || null;
}

/**
 * Resolve telefone a partir do raw_payload do webhook.
 * Aceita vários nomes de chave usados por diferentes origens (DataCrazy, n8n, CAA).
 * @param {Record<string, unknown>|null|undefined} raw
 * @returns {string|null}
 */
export function telefoneFromRawPayload(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const candidates = [
    raw['Telefone do Lead'],
    raw['Telefone'],
    raw['telefone'],
    raw['phone'],
    raw['Phone'],
    raw['numero'],
    raw['Numero'],
    raw['celular'],
    raw['Celular'],
  ];
  for (const c of candidates) {
    if (typeof c === 'string' && c.trim()) return c.trim();
    if (typeof c === 'number' && c) return String(c);
  }
  return null;
}

/**
 * Resolve datacrazy_lead_id a partir do raw_payload do webhook.
 * @param {Record<string, unknown>|null|undefined} raw
 * @returns {string|null}
 */
export function leadIdFromRawPayload(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const candidates = [
    raw['Id do Lead'],
    raw['id_do_lead'],
    raw['lead_id'],
    raw['leadId'],
    raw['datacrazy_lead_id'],
    raw['datacrazyLeadId'],
  ];
  for (const c of candidates) {
    const s = c != null ? String(c).trim() : '';
    if (s) return s;
  }
  return null;
}

/**
 * Resolve origem_ativacao a partir do raw_payload do webhook.
 * Aceita o campo "Origem Ativação" (com ou sem acento) e variantes snake_case.
 * Retorna só valores reconhecidos pelo enum do sistema.
 * @param {Record<string, unknown>|null|undefined} raw
 * @returns {string|null}
 */
export function origemAtivacaoFromRawPayload(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const VALID = new Set(['caa', 'caa_atm', 'caa_ia']);
  const candidates = [
    raw['Origem Ativação'],
    raw['Origem Ativacao'],
    raw['origem_ativacao'],
    raw['origemAtivacao'],
  ];
  for (const c of candidates) {
    if (typeof c === 'string' && c.trim()) {
      const v = c.trim().toLowerCase();
      if (VALID.has(v)) return v;
    }
  }
  return null;
}

/**
 * @param {string|null|undefined} telefone
 * @returns {Promise<string|null>}
 */
async function findRgmByPhoneInLk(telefone) {
  const tel = normalizePhoneOrRaw(telefone);
  if (!tel) return null;
  const { rows } = await query(
    `select rgm from mv_aluno_por_telefone where phone_norm = normalize_phone_br($1) limit 1`,
    [tel]
  );
  const rgm = rows[0]?.rgm;
  if (!rgm || !String(rgm).trim()) return null;
  return normalizeRgmCanonical(rgm) || String(rgm).trim();
}

/**
 * Preenche consultor/RGM faltantes a partir de raw_payload, MV telefone e dispatch.
 * @param {{ days?: number, category?: string|null }} [opts]
 * @returns {Promise<{ consultor: number, rgm_payload: number, rgm_lk: number, rgm_dispatch: number }>}
 */
export async function backfillResponsesMissingIdentity(opts = {}) {
  const days = Math.max(1, Math.floor(Number(opts.days) || 30));
  const category = opts.category ? String(opts.category).trim() : null;

  const categoryFilter = category ? 'and ar.category = $2' : '';
  const params = [days];
  if (category) params.push(category);

  // Step 0 — backfill datacrazy_lead_id de raw_payload->'Id do Lead' quando ausente
  const leadIdPayload = await query(
    `update activation_responses ar
        set datacrazy_lead_id = nullif(trim(ar.raw_payload->>'Id do Lead'), '')
      where ar.datacrazy_lead_id is null
        and nullif(trim(ar.raw_payload->>'Id do Lead'), '') is not null
        and ar.received_at >= now() - ($1::int * interval '1 day')
        ${categoryFilter}`,
    params
  );

  // Step 1 — backfill consultor de raw_payload (só Wesley/Danubia em processos-caa)
  const consultor = await query(
    `update activation_responses ar
        set consultor_responsavel_nome = trim(both from coalesce(
              nullif(trim(ar.raw_payload->>'Consultor'), ''),
              nullif(trim(ar.raw_payload->>'consultor'), '')
            ))
      where nullif(trim(coalesce(
              ar.raw_payload->>'Consultor',
              ar.raw_payload->>'consultor',
              ''
            )), '') is not null
        and ar.received_at >= now() - ($1::int * interval '1 day')
        ${categoryFilter}
        and (
          ar.category <> 'processos-caa'
          or lower(trim(coalesce(
                ar.raw_payload->>'Consultor',
                ar.raw_payload->>'consultor',
                ''
              ))) like 'wesley%'
          or lower(trim(coalesce(
                ar.raw_payload->>'Consultor',
                ar.raw_payload->>'consultor',
                ''
              ))) like 'danubia%'
        )
        and (
          nullif(trim(coalesce(ar.consultor_responsavel_nome, '')), '') is null
          or lower(trim(ar.consultor_responsavel_nome)) <> lower(trim(coalesce(
                ar.raw_payload->>'Consultor',
                ar.raw_payload->>'consultor',
                ''
              )))
        )`,
    params
  );

  // Step 1b — limpa consultor inválido já gravado em processos-caa
  const consultorClear = await query(
    `update activation_responses ar
        set consultor_responsavel_nome = null
      where ar.category = 'processos-caa'
        and nullif(trim(coalesce(ar.consultor_responsavel_nome, '')), '') is not null
        and lower(trim(ar.consultor_responsavel_nome)) not like 'wesley%'
        and lower(trim(ar.consultor_responsavel_nome)) not like 'danubia%'
        and ar.received_at >= now() - ($1::int * interval '1 day')
        ${categoryFilter}`,
    params
  );

  const rgmPayload = await query(
    `update activation_responses ar
        set rgm = nullif(regexp_replace(coalesce(ar.raw_payload->>'RGM', ar.raw_payload->>'rgm', ''), '[^0-9]', '', 'g'), ''),
            master_key = coalesce(
              nullif(trim(ar.master_key), ''),
              case
                when nullif(regexp_replace(coalesce(ar.raw_payload->>'RGM', ar.raw_payload->>'rgm', ''), '[^0-9]', '', 'g'), '') is not null
                then 'RGM:' || nullif(regexp_replace(coalesce(ar.raw_payload->>'RGM', ar.raw_payload->>'rgm', ''), '[^0-9]', '', 'g'), '')
                else ar.master_key
              end
            )
      where nullif(trim(coalesce(ar.rgm, '')), '') is null
        and length(regexp_replace(coalesce(ar.raw_payload->>'RGM', ar.raw_payload->>'rgm', ''), '[^0-9]', '', 'g')) >= 5
        and ar.received_at >= now() - ($1::int * interval '1 day')
        ${categoryFilter}`,
    params
  );

  const rgmLk = await query(
    `update activation_responses ar
        set rgm = lk.rgm,
            master_key = coalesce(nullif(trim(ar.master_key), ''), 'RGM:' || lk.rgm)
       from mv_aluno_por_telefone lk
      where lk.phone_norm = normalize_phone_br(ar.telefone)
        and nullif(trim(coalesce(ar.rgm, '')), '') is null
        and nullif(trim(coalesce(lk.rgm, '')), '') is not null
        and ar.received_at >= now() - ($1::int * interval '1 day')
        ${categoryFilter}`,
    params
  );

  const rgmDispatch = await query(
    `with candidates as (
       select ar.id,
              (
                select de.rgm
                  from activation_dispatch_events de
                 where de.status = 'sent'
                   and de.category = ar.category
                   and nullif(trim(coalesce(de.rgm, '')), '') is not null
                   and regexp_replace(coalesce(de.telefone, ''), '[^0-9]', '', 'g')
                       = regexp_replace(coalesce(ar.telefone, ''), '[^0-9]', '', 'g')
                   and de.created_at <= coalesce(ar.received_at, ar.created_at)
                   and de.created_at >= coalesce(ar.received_at, ar.created_at) - interval '72 hours'
                 order by de.created_at desc
                 limit 1
              ) as rgm
         from activation_responses ar
        where nullif(trim(coalesce(ar.rgm, '')), '') is null
          and ar.received_at >= now() - ($1::int * interval '1 day')
          ${categoryFilter}
     )
     update activation_responses ar
        set rgm = c.rgm,
            master_key = coalesce(nullif(trim(ar.master_key), ''), 'RGM:' || c.rgm)
       from candidates c
      where ar.id = c.id
        and c.rgm is not null`,
    params
  );

  // Step 5 — backfill rgm via datacrazy_lead_cache (lookup por lead_id → CPF → matriculados)
  const rgmCacheLeadId = await query(
    `with matched as (
       select ar.id,
              nullif(trim(coalesce(
                mr.data->>'RGM', mr.data->>'Rgm', mr.data->>'Matricula', mr.data->>'matricula', ''
              )), '') as rgm
         from activation_responses ar
         join datacrazy_lead_cache dlc
           on dlc.datacrazy_lead_id = ar.datacrazy_lead_id
         join matriculados_rows mr
           on mr.snapshot_id = (
                select id from matriculados_snapshots order by created_at desc limit 1
              )
          and regexp_replace(coalesce(mr.data->>'CPF', mr.data->>'Cpf', mr.data->>'Cpf Aluno', ''), '[^0-9]', '', 'g')
              = regexp_replace(dlc.cpf, '[^0-9]', '', 'g')
        where nullif(trim(coalesce(ar.rgm, '')), '') is null
          and ar.datacrazy_lead_id is not null
          and ar.received_at >= now() - ($1::int * interval '1 day')
          ${categoryFilter}
        order by ar.id, mr.data->>'Data Matrícula' desc nulls last
     )
     update activation_responses ar
        set rgm = m.rgm,
            master_key = coalesce(nullif(trim(ar.master_key), ''), 'RGM:' || m.rgm)
       from (select distinct on (id) id, rgm from matched where rgm is not null) m
      where ar.id = m.id`,
    params
  );

  return {
    lead_id_payload: leadIdPayload.rowCount ?? 0,
    consultor: consultor.rowCount ?? 0,
    consultor_clear: consultorClear.rowCount ?? 0,
    rgm_payload: rgmPayload.rowCount ?? 0,
    rgm_lk: rgmLk.rowCount ?? 0,
    rgm_dispatch: rgmDispatch.rowCount ?? 0,
    rgm_cache_lead_id: rgmCacheLeadId.rowCount ?? 0,
  };
}

/**
 * Insere uma resposta (idempotente via external_id + category + dia).
 * Quando master_key/lead_id/phone faltam, tenta resolver pelo payload e pelo
 * último dispatch. Em conflito (mesmo external_id+category+dia), faz DO UPDATE
 * para enriquecer campos nulos (consultor, rgm, master_key, origem_ativacao,
 * datacrazy_lead_id) e mescla raw_payload via jsonb merge.
 *
 * @param {{
 *   category?: string|null,
 *   masterKey?: string|null,
 *   datacrazyLeadId?: string|null,
 *   telefone?: string|null,
 *   rgm?: string|null,
 *   cpf?: string|null,
 *   origemAtivacao?: string|null,
 *   responseKind?: 'click'|'message'|'opt_out'|'other',
 *   buttonPayload?: string|null,
 *   messageText?: string|null,
 *   externalId?: string|null,
 *   consultorResponsavelNome?: string|null,
 *   rawPayload?: Record<string, unknown>|null,
 *   receivedAt?: Date|string|null,
 * }} input
 */
export async function recordResponse(input) {
  const rawPayload = input.rawPayload ?? null;

  // Resolve telefone: input explícito → raw_payload
  const telRaw = input.telefone ?? telefoneFromRawPayload(rawPayload);
  const telNorm = normalizePhoneOrRaw(telRaw);

  // Resolve datacrazy_lead_id: input explícito → raw_payload
  const datacrazyLeadId =
    (input.datacrazyLeadId != null
      ? String(input.datacrazyLeadId).trim()
      : null) ||
    leadIdFromRawPayload(rawPayload) ||
    null;

  const cpfDigits = normalizeCpfDigits(input.cpf);

  // Matriculados é fonte de verdade do RGM quando há CPF (matrícula mais recente).
  let rgm = null;
  if (cpfDigits) {
    rgm = await findRgmByCpfInMatriculados(cpfDigits);
  }
  if (!rgm && input.rgm) {
    rgm = normalizeRgmCanonical(input.rgm);
  }
  if (!rgm) {
    rgm = rgmFromRawPayload(rawPayload);
  }
  if (!rgm && telNorm) {
    rgm = await findRgmByPhoneInLk(telNorm);
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
      datacrazyLeadId,
      telefone: telNorm,
    });
    if (resolved) {
      category = category ?? resolved.category;
      masterKey = resolved.master_key;
      if (!rgm && resolved.rgm) rgm = normalizeRgmCanonical(resolved.rgm);
    }
  }

  const consultorNome = sanitizeCaaConsultorForStorage(
    category,
    (typeof input.consultorResponsavelNome === 'string' && input.consultorResponsavelNome.trim()
      ? input.consultorResponsavelNome.trim().slice(0, 200)
      : null) ?? consultorFromRawPayload(rawPayload)
  );

  // Resolve origem_ativacao: input explícito → raw_payload
  const origemAtivacao =
    (input.origemAtivacao && String(input.origemAtivacao).trim()) ||
    origemAtivacaoFromRawPayload(rawPayload) ||
    null;

  const params = [
    category,
    masterKey,
    datacrazyLeadId,
    telNorm,
    rgm,
    input.responseKind ?? 'click',
    input.buttonPayload ?? null,
    input.messageText ?? null,
    input.externalId ?? null,
    rawPayload ? JSON.stringify(rawPayload) : null,
    input.receivedAt ? new Date(input.receivedAt) : new Date(),
    consultorNome,
    origemAtivacao,
  ];

  const { rows } = await query(
    `insert into activation_responses (
       category, master_key, datacrazy_lead_id, telefone, rgm,
       response_kind, button_payload, message_text, external_id,
       raw_payload, received_at, consultor_responsavel_nome, origem_ativacao
     ) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb,$11,$12,$13)
     on conflict (external_id, category, ((received_at at time zone 'UTC')::date))
     where external_id is not null
     do update set
       consultor_responsavel_nome = case
         when coalesce(excluded.category, activation_responses.category) = 'processos-caa' then
           case
             when nullif(trim(coalesce(
               excluded.consultor_responsavel_nome,
               excluded.raw_payload->>'Consultor',
               excluded.raw_payload->>'consultor',
               activation_responses.consultor_responsavel_nome,
               ''
             )), '') ilike 'wesley%'
               or nullif(trim(coalesce(
                 excluded.consultor_responsavel_nome,
                 excluded.raw_payload->>'Consultor',
                 excluded.raw_payload->>'consultor',
                 activation_responses.consultor_responsavel_nome,
                 ''
               )), '') ilike 'danubia%'
             then nullif(trim(coalesce(
               excluded.consultor_responsavel_nome,
               excluded.raw_payload->>'Consultor',
               excluded.raw_payload->>'consultor',
               activation_responses.consultor_responsavel_nome,
               ''
             )), '')
             else activation_responses.consultor_responsavel_nome
           end
         else coalesce(
           nullif(trim(excluded.consultor_responsavel_nome), ''),
           nullif(trim(excluded.raw_payload->>'Consultor'), ''),
           nullif(trim(excluded.raw_payload->>'consultor'), ''),
           nullif(trim(activation_responses.consultor_responsavel_nome), '')
         )
       end,
       rgm = coalesce(activation_responses.rgm, excluded.rgm),
       master_key = coalesce(activation_responses.master_key, excluded.master_key),
       datacrazy_lead_id = coalesce(activation_responses.datacrazy_lead_id, excluded.datacrazy_lead_id),
       origem_ativacao = coalesce(activation_responses.origem_ativacao, excluded.origem_ativacao),
       raw_payload = case
         when activation_responses.raw_payload is null then excluded.raw_payload
         when excluded.raw_payload is null then activation_responses.raw_payload
         else activation_responses.raw_payload || excluded.raw_payload
       end
     returning id, category, master_key, datacrazy_lead_id, telefone,
               response_kind, received_at, consultor_responsavel_nome`,
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
 * Aplica filtro defensivo: só conta respostas que tenham um `activation_dispatch_events`
 * com `status='sent'` para a mesma master_key/category, com `created_at`
 * dentro de `staleHours` antes do `received_at` da resposta. Respostas
 * "órfãs" (sem dispatch recente) ficam no DB para auditoria mas não aparecem
 * no roster — evita falso-positivo causado por `origem_ativacao` antigo.
 *
 * @param {string} category
 * @param {string[]} masterKeys
 * @param {number} [staleHours=72]
 */
export async function findLastByMasterKeys(category, masterKeys, staleHours = 72) {
  const keys = [...new Set(masterKeys.filter(Boolean))];
  if (!keys.length) return new Map();
  const safeHours = Math.max(1, Math.floor(Number(staleHours) || 72));
  const { rows } = await query(
    `select distinct on (r.master_key)
       r.master_key, r.response_kind, r.button_payload, r.message_text, r.received_at
       from activation_responses r
      where r.category = $1
        and r.master_key = any($2::text[])
        and exists (
          select 1 from activation_dispatch_events d
          where d.master_key = r.master_key
            and d.category = r.category
            and d.status = 'sent'
            and d.created_at <= coalesce(r.received_at, r.created_at)
            and d.created_at >= coalesce(r.received_at, r.created_at) - ($3::int * interval '1 hour')
        )
      order by r.master_key, r.received_at desc`,
    [category, keys, safeHours]
  );
  return new Map(rows.map((r) => [r.master_key, r]));
}

/**
 * Retorna um Set com os master_keys que TÊM resposta válida (correlacionada
 * com dispatch dentro da janela staleHours). Versão mais barata do que
 * findLastByMasterKeys quando só importa saber "respondeu ou não".
 *
 * @param {string} category
 * @param {string[]} masterKeys
 * @param {number} [staleHours=72]
 * @returns {Promise<Set<string>>}
 */
export async function findRespondedMasterKeys(category, masterKeys, staleHours = 72) {
  const keys = [...new Set(masterKeys.filter(Boolean))];
  if (!keys.length) return new Set();
  const safeHours = Math.max(1, Math.floor(Number(staleHours) || 72));
  const { rows } = await query(
    `select distinct r.master_key
       from activation_responses r
      where r.category = $1
        and r.master_key = any($2::text[])
        and exists (
          select 1 from activation_dispatch_events d
          where d.master_key = r.master_key
            and d.category = r.category
            and d.status = 'sent'
            and d.created_at <= coalesce(r.received_at, r.created_at)
            and d.created_at >= coalesce(r.received_at, r.created_at) - ($3::int * interval '1 hour')
        )`,
    [category, keys, safeHours]
  );
  return new Set(rows.map((r) => r.master_key));
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

/**
 * Atualiza consultor_responsavel_nome de uma resposta especifica.
 * Aceita null pra desatribuir. Retorna a linha atualizada ou null se id nao existe.
 *
 * @param {string} id
 * @param {string|null} consultorNome
 * @returns {Promise<ActivationResponseRow|null>}
 */
export async function updateConsultorResponsavel(id, consultorNome) {
  const { rows: existing } = await query(
    `select category from activation_responses where id = $1`,
    [id]
  );
  const category = existing[0]?.category ?? null;
  const clean = sanitizeCaaConsultorForStorage(category, consultorNome);
  const { rows } = await query(
    `update activation_responses
        set consultor_responsavel_nome = $2
      where id = $1
      returning id, category, master_key, rgm, telefone,
                response_kind, received_at, consultor_responsavel_nome`,
    [id, clean]
  );
  return rows[0] ?? null;
}

const CONSULTOR_CRM_FIELD_ID = process.env.DATACRAZY_CONSULTOR_RESPONSAVEL_FIELD_ID || '';

/**
 * Preenche consultor_responsavel_nome via campo customizado do DataCrazy CRM
 * para leads que ainda não têm consultor no payload nem na coluna.
 *
 * @param {{ days?: number, limit?: number, category?: string|null }} [opts]
 */
export async function syncConsultorFromCrmForResponses(opts = {}) {
  const days = Math.max(1, Math.floor(Number(opts.days) || 14));
  const limit = Math.min(Math.max(Number(opts.limit) || 500, 1), 2000);
  const category = opts.category ? String(opts.category).trim() : null;

  if (!CONSULTOR_CRM_FIELD_ID) {
    return {
      scanned: 0,
      updated: 0,
      failed: 0,
      skipped_no_config: true,
      field_id: null,
      days,
      category,
    };
  }

  const categoryFilter = category ? 'and ar.category = $3' : '';
  const params = category ? [days, limit, category] : [days, limit];

  const { rows } = await query(
    `select ar.id, ar.datacrazy_lead_id, ar.category
       from activation_responses ar
      where ar.datacrazy_lead_id is not null
        and ar.received_at >= now() - ($1::int * interval '1 day')
        ${categoryFilter}
        and (
          (
            ar.category <> 'processos-caa'
            and nullif(trim(coalesce(
              ar.raw_payload->>'Consultor',
              ar.raw_payload->>'consultor',
              ar.consultor_responsavel_nome,
              ''
            )), '') is null
          )
          or (
            ar.category = 'processos-caa'
            and (
              nullif(trim(coalesce(ar.consultor_responsavel_nome, '')), '') is null
              or (
                lower(trim(ar.consultor_responsavel_nome)) not like 'wesley%'
                and lower(trim(ar.consultor_responsavel_nome)) not like 'danubia%'
              )
            )
          )
        )
      order by ar.received_at desc
      limit $2`,
    params
  );

  const { datacrazyClient } = await import('../services/datacrazyClient.js');
  const { datacrazyCrmLimiter } = await import('../utils/datacrazyCrmLimiter.js');

  let updated = 0;
  let failed = 0;

  for (const row of rows) {
    try {
      await datacrazyCrmLimiter.acquire();
      const raw = await datacrazyClient.getLeadAdditionalFieldValue(
        row.datacrazy_lead_id,
        CONSULTOR_CRM_FIELD_ID
      );
      const nome = sanitizeCaaConsultorForStorage(
        row.category,
        typeof raw === 'string' && raw.trim() ? raw.trim().slice(0, 200) : null
      );
      if (!nome) continue;
      await query(
        `update activation_responses
            set consultor_responsavel_nome = $2
          where id = $1`,
        [row.id, nome]
      );
      updated += 1;
    } catch {
      failed += 1;
    }
  }

  return {
    scanned: rows.length,
    updated,
    failed,
    skipped_no_config: false,
    field_id: CONSULTOR_CRM_FIELD_ID,
    days,
    category,
  };
}

/**
 * Lista valores distintos de consultor_responsavel_nome ja gravados no banco.
 * Usado pelo autocomplete do modal de atribuicao manual.
 *
 * @returns {Promise<string[]>}
 */
export async function listDistinctConsultores() {
  const { rows } = await query(
    `select distinct nome from (
       select nullif(trim(consultor_responsavel_nome), '') as nome
         from activation_responses
        where consultor_responsavel_nome is not null
       union
       select nullif(trim(raw_payload->>'Consultor'), '') as nome
         from activation_responses
        where nullif(trim(raw_payload->>'Consultor'), '') is not null
       union
       select nullif(trim(raw_payload->>'consultor'), '') as nome
         from activation_responses
        where nullif(trim(raw_payload->>'consultor'), '') is not null
     ) t
     where nome is not null and nome <> ''
     order by nome asc
     limit 500`
  );
  return rows.map((r) => r.nome).filter(Boolean);
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
