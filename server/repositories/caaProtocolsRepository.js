import { query, getPool } from '../db/client.js';
import { normalizeCaaStatus } from '../utils/caaRowFilters.js';
import { repairCaaExportRow } from '../utils/caaExportRepair.js';

/**
 * @typedef {Object} CaaProtocolInput
 * @property {string} protocolo
 * @property {string|null} rgm
 * @property {string|null} cpf
 * @property {string|null} nome
 * @property {string|null} email
 * @property {string|null} telefone
 * @property {string|null} polo
 * @property {string|null} curso
 * @property {string|null} instituicao
 * @property {string|null} subprocesso
 * @property {string|null} data_chegada
 * @property {string|null} data_previsao
 * @property {string|null} data_conclusao
 * @property {string|null} situacao_atendimento_raw
 * @property {string|null} situacao_deferimento_raw
 * @property {import('../utils/caaRowFilters.js').CaaStatus} status
 * @property {Record<string, unknown>} raw
 */

/**
 * @param {Record<string, unknown>} row
 * @returns {CaaProtocolInput | null}
 */
export function protocolFromRow(row) {
  const fixed =
    row && typeof row === 'object' ? repairCaaExportRow(/** @type {Record<string, unknown>} */ (row)) : row;
  const protocolo = String(fixed?.Protocolo ?? fixed?.protocolo ?? '').trim();
  if (!protocolo) return null;
  // Protocolo CAA é numérico, 9-12 dígitos. Qualquer outra coisa (texto descritivo
  // de colunas embaralhadas, lixo) é rejeitada para não poluir caa_protocols com
  // entradas fantasma. Repair V1/V2 tenta corrigir antes; se ainda assim não bater,
  // pula a linha.
  const onlyDigits = protocolo.replace(/\D/g, '');
  if (onlyDigits.length < 9 || onlyDigits.length > 12) return null;
  return {
    protocolo: onlyDigits,
    rgm: nullable(fixed.RGM ?? fixed.Rgm),
    cpf: nullable(fixed.CPF ?? fixed.Cpf ?? fixed['Cpf Aluno']),
    nome: nullable(fixed.Aluno ?? fixed.Nome ?? fixed['Nome Aluno']),
    email: nullable(fixed.Email ?? fixed['E-mail'] ?? fixed['E-mail Aluno']),
    telefone: nullable(fixed.Celular ?? fixed['Fone celular'] ?? fixed.Telefone),
    polo: nullable(fixed.Polo),
    curso: nullable(fixed.Curso),
    instituicao: nullable(fixed['Instituição'] ?? fixed.Instituicao),
    subprocesso: nullable(fixed.Subprocesso),
    data_chegada: nullable(fixed['Data Chegada']),
    data_previsao: nullable(fixed['Data Previsão'] ?? fixed['Data Previsao']),
    data_conclusao: nullable(fixed['Data Conclusão'] ?? fixed['Data Conclusao']),
    situacao_atendimento_raw: nullable(fixed['Situação Atendimento'] ?? fixed['Situacao Atendimento']),
    situacao_deferimento_raw: nullable(fixed['Situação Deferimento'] ?? fixed['Situacao Deferimento']),
    status: normalizeCaaStatus(fixed),
    raw: fixed,
  };
}

function nullable(v) {
  if (v === undefined || v === null) return null;
  const s = String(v).trim();
  return s === '' ? null : s;
}

/**
 * UPSERT em lote + grava transições quando status muda.
 * Retorna contagens de mudanças.
 * @param {CaaProtocolInput[]} inputs
 * @param {string} snapshotId
 */
export async function upsertProtocolsWithTransitions(inputs, snapshotId) {
  const stats = {
    total: inputs.length,
    new_protocols: 0,
    status_changed: 0,
    transitions: /** @type {Array<{ protocolo: string, rgm: string|null, from: string|null, to: string }>} */ ([]),
  };
  if (!inputs.length) return stats;

  const pool = getPool();
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const protocolos = inputs.map((p) => p.protocolo);
    const { rows: existing } = await client.query(
      `select protocolo, status from caa_protocols where protocolo = any($1::text[])`,
      [protocolos]
    );
    const existingMap = new Map(existing.map((r) => [r.protocolo, r.status]));

    const CHUNK = 500;
    for (let i = 0; i < inputs.length; i += CHUNK) {
      const slice = inputs.slice(i, i + CHUNK);
      const valueParts = [];
      const params = [];
      let p = 1;
      for (const it of slice) {
        valueParts.push(
          `($${p++}, $${p++}, $${p++}, $${p++}, $${p++}, $${p++}, $${p++}, $${p++}, $${p++}, $${p++}, $${p++}, $${p++}, $${p++}, $${p++}, $${p++}, $${p++}, $${p++}::uuid, $${p++}::uuid, $${p++}::jsonb)`
        );
        params.push(
          it.protocolo,
          it.rgm,
          it.cpf,
          it.nome,
          it.email,
          it.telefone,
          it.polo,
          it.curso,
          it.instituicao,
          it.subprocesso,
          it.data_chegada,
          it.data_previsao,
          it.data_conclusao,
          it.situacao_atendimento_raw,
          it.situacao_deferimento_raw,
          it.status,
          snapshotId,
          snapshotId,
          JSON.stringify(it.raw)
        );
      }

      await client.query(
        `insert into caa_protocols (
           protocolo, rgm, cpf, nome, email, telefone, polo, curso, instituicao,
           subprocesso, data_chegada, data_previsao, data_conclusao,
           situacao_atendimento_raw, situacao_deferimento_raw, status,
           first_snapshot_id, last_snapshot_id, data
         )
         values ${valueParts.join(', ')}
         on conflict (protocolo) do update set
           rgm                       = excluded.rgm,
           cpf                       = excluded.cpf,
           nome                      = excluded.nome,
           email                     = excluded.email,
           telefone                  = excluded.telefone,
           polo                      = excluded.polo,
           curso                     = excluded.curso,
           instituicao               = excluded.instituicao,
           subprocesso               = excluded.subprocesso,
           data_chegada              = excluded.data_chegada,
           data_previsao             = excluded.data_previsao,
           data_conclusao            = excluded.data_conclusao,
           situacao_atendimento_raw  = excluded.situacao_atendimento_raw,
           situacao_deferimento_raw  = excluded.situacao_deferimento_raw,
           status                    = excluded.status,
           last_snapshot_id          = excluded.last_snapshot_id,
           last_seen_at              = now(),
           last_status_change_at     = case
                                         when caa_protocols.status is distinct from excluded.status
                                         then now()
                                         else caa_protocols.last_status_change_at
                                       end,
           data                      = excluded.data`,
        params
      );

      const transValues = [];
      const transParams = [];
      let tp = 1;
      for (const it of slice) {
        const prev = existingMap.get(it.protocolo);
        if (prev === undefined) {
          stats.new_protocols += 1;
          transValues.push(
            `($${tp++}, $${tp++}, null, $${tp++}, null, null, $${tp++}, $${tp++}, $${tp++}::uuid)`
          );
          transParams.push(
            it.protocolo,
            it.rgm,
            it.status,
            it.situacao_atendimento_raw,
            it.situacao_deferimento_raw,
            snapshotId
          );
          stats.transitions.push({ protocolo: it.protocolo, rgm: it.rgm, from: null, to: it.status });
        } else if (prev !== it.status) {
          stats.status_changed += 1;
          transValues.push(
            `($${tp++}, $${tp++}, $${tp++}, $${tp++}, null, null, $${tp++}, $${tp++}, $${tp++}::uuid)`
          );
          transParams.push(
            it.protocolo,
            it.rgm,
            prev,
            it.status,
            it.situacao_atendimento_raw,
            it.situacao_deferimento_raw,
            snapshotId
          );
          stats.transitions.push({ protocolo: it.protocolo, rgm: it.rgm, from: prev, to: it.status });
        }
      }
      if (transValues.length) {
        await client.query(
          `insert into caa_protocol_transitions
             (protocolo, rgm, from_status, to_status, from_raw_att, from_raw_def, to_raw_att, to_raw_def, snapshot_id)
           values ${transValues.join(', ')}`,
          transParams
        );
      }

      for (const it of slice) {
        existingMap.set(it.protocolo, it.status);
      }
    }

    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
  return stats;
}

/**
 * Linhas atuais com status='open' (fila CAA, dedup por RGM).
 * Mantém apenas 1 linha por RGM (a mais recente).
 */
export async function listOpenProtocolsByRgm() {
  const { rows } = await query(`
    select distinct on (coalesce(rgm, protocolo))
      protocolo, rgm, cpf, nome, email, telefone, polo, curso, instituicao,
      subprocesso, data_chegada, data_previsao, situacao_atendimento_raw,
      situacao_deferimento_raw, status, last_seen_at, last_status_change_at,
      first_seen_at, data
    from caa_protocols
    where status = 'open'
    order by coalesce(rgm, protocolo), last_status_change_at desc
  `);
  return rows;
}

/**
 * T0 do protocolo CAA para janela de Retenção no CRM.
 * Usa exclusivamente `first_seen_at` — o momento em que o protocolo apareceu
 * pela primeira vez em um dos nossos uploads. `data_chegada` do arquivo
 * (campo Excel) é ignorada para esta janela porque pode diferir do momento
 * real de entrada no fluxo operacional.
 * @param {object} p
 * @returns {Date|null}
 */
export function caaProtocolT0(p) {
  const raw = p?.first_seen_at || null;
  if (!raw) return null;
  const d = raw instanceof Date ? raw : new Date(raw);
  return Number.isNaN(d.getTime()) ? null : d;
}

/**
 * Map `cpf:…` / `rgm:…` → Date (T0) dos protocolos CAA `open`.
 * Se a mesma chave aparece em mais de um protocolo, fica o T0 mais recente.
 * @returns {Promise<Map<string, Date>>}
 */
export async function loadOpenCaaT0Map() {
  const rows = await listOpenProtocolsByRgm();
  /** @type {Map<string, Date>} */
  const map = new Map();
  const put = (key, t0) => {
    if (!key || !t0) return;
    const prev = map.get(key);
    if (!prev || t0.getTime() > prev.getTime()) map.set(key, t0);
  };
  for (const p of rows) {
    const data = p?.data && typeof p.data === 'object' ? p.data : {};
    const cpf = String(p.cpf || data.CPF || data.cpf || '').replace(/\D/g, '');
    const rgm = String(p.rgm || data.RGM || data.rgm || '').replace(/\D/g, '');
    const t0 = caaProtocolT0(p);
    if (!t0) continue;
    if (cpf.length >= 11) put(`cpf:${cpf}`, t0);
    if (rgm) put(`rgm:${rgm}`, t0);
  }
  return map;
}

/**
 * Set `cpf:…` / `rgm:…` da fila CAA aberta (status='open' em caa_protocols).
 * @returns {Promise<Set<string>>}
 */
export async function loadOpenCaaIdSet() {
  const map = await loadOpenCaaT0Map();
  return new Set(map.keys());
}

/**
 * Identidades que **já apareceram** em qualquer upload CAA (`caa_protocols`,
 * qualquer status). O XLSX do dia é D−1: quem estava ontem não vem hoje —
 * não dá para usar o snapshot diário como “ainda está / saiu”.
 * Chaves `cpf:` (11 dígitos) / `rgm:` — mesmo formato de `loadIdSetFromBase`.
 * @returns {Promise<Set<string>>}
 */
export async function loadSeenCaaIdSet() {
  const { rows } = await query(`
    select cpf, rgm, data
      from caa_protocols
  `);
  const set = new Set();
  for (const p of rows) {
    const data = p?.data && typeof p.data === 'object' ? p.data : {};
    const cpfRaw = String(p.cpf || data.CPF || data.cpf || '').replace(/\D/g, '');
    const rgm = String(p.rgm || data.RGM || data.rgm || '').replace(/\D/g, '');
    const cpf =
      cpfRaw.length >= 9 && cpfRaw.length <= 11 ? cpfRaw.padStart(11, '0') : cpfRaw;
    if (cpf.length === 11) set.add(`cpf:${cpf}`);
    if (rgm) set.add(`rgm:${rgm}`);
  }
  return set;
}

/**
 * @param {Map<string, Date>} t0Map
 * @param {string} cpf
 * @param {string} rgm
 * @returns {Date|null}
 */
export function lookupCaaT0(t0Map, cpf, rgm) {
  if (!t0Map || typeof t0Map.get !== 'function') return null;
  if (cpf && t0Map.has(`cpf:${cpf}`)) return t0Map.get(`cpf:${cpf}`) || null;
  if (rgm && t0Map.has(`rgm:${rgm}`)) return t0Map.get(`rgm:${rgm}`) || null;
  return null;
}

/**
 * Estatísticas de transições nas últimas 24h (ou em um intervalo ou por snapshot).
 *
 * `novos_pendentes` conta apenas protocolos que apareceram pela primeira vez
 * com status=open E que AINDA estão em status=open agora — protocolos que
 * entraram e já foram resolvidos no mesmo dia entram em perdidos/revertidos.
 *
 * @param {{ since?: Date, snapshotId?: string }} [opts]
 */
export async function getDailyTransitionStats(opts = {}) {
  const useSnapshot = Boolean(opts.snapshotId);
  const since = opts.since ?? new Date(Date.now() - 24 * 60 * 60 * 1000);
  const params = useSnapshot ? [opts.snapshotId] : [since];
  const whereClause = useSnapshot ? `t.snapshot_id = $1::uuid` : `t.changed_at >= $1`;

  const { rows } = await query(
    `with latest as (
       select id from processos_caa_snapshots order by created_at desc limit 1
     ),
     windowed as (
       select t.*,
              p.status            as current_status,
              p.last_snapshot_id  as current_snapshot
         from caa_protocol_transitions t
         left join caa_protocols p on p.protocolo = t.protocolo
        where ${whereClause}
     )
     select
       count(*) filter (
         where w.to_status = 'open' and w.from_status is null
           and w.current_status = 'open'
           and w.current_snapshot = l.id
       )::int as novos_pendentes,
       count(*) filter (where w.from_status = 'open' and w.to_status = 'lost_canceled')  ::int as perdidos_canceled,
       count(*) filter (where w.from_status = 'open' and w.to_status = 'lost_confirmed') ::int as perdidos_confirmed,
       count(*) filter (where w.from_status = 'open' and w.to_status = 'won_reverted')   ::int as revertidos
     from windowed w, latest l`,
    params
  );
  return rows[0];
}

/**
 * Lista detalhada das transições no período, prontas para UI.
 *
 * `requireCurrentStatus`: se passado, só retorna transições cujo protocolo
 * ainda está nesse status (evita mostrar "novos pendentes" que já foram
 * resolvidos no snapshot seguinte).
 *
 * @param {{ since?: Date, snapshotId?: string, toStatus?: string|string[], limit?: number, requireCurrentStatus?: string }} [opts]
 */
export async function listRecentTransitions(opts = {}) {
  const useSnapshot = Boolean(opts.snapshotId);
  const since = opts.since ?? new Date(Date.now() - 24 * 60 * 60 * 1000);
  const limit = opts.limit ?? 500;
  const toStatuses = Array.isArray(opts.toStatus) ? opts.toStatus : opts.toStatus ? [opts.toStatus] : null;
  const params = useSnapshot ? [opts.snapshotId] : [since];
  let where = useSnapshot ? `t.snapshot_id = $1::uuid` : `t.changed_at >= $1`;
  if (toStatuses && toStatuses.length) {
    params.push(toStatuses);
    where += ` and t.to_status = any($${params.length}::text[])`;
  }
  if (opts.requireCurrentStatus) {
    params.push(opts.requireCurrentStatus);
    where += ` and p.status = $${params.length}
                and p.last_snapshot_id = (
                  select id from processos_caa_snapshots order by created_at desc limit 1
                )`;
  }
  params.push(limit);
  const { rows } = await query(
    `select t.protocolo, t.rgm, t.from_status, t.to_status, t.changed_at,
            p.status as current_status,
            p.nome, p.email, p.telefone, p.polo, p.curso, p.subprocesso,
            p.data_chegada, p.data_previsao, p.data_conclusao,
            p.situacao_atendimento_raw, p.situacao_deferimento_raw
       from caa_protocol_transitions t
       left join caa_protocols p on p.protocolo = t.protocolo
      where ${where}
      order by t.changed_at desc
      limit $${params.length}`,
    params
  );
  return rows;
}

/**
 * Protocolos com status='open' para um RGM específico.
 * Retorna array de strings (Protocolo) ordenados por última mudança de status.
 * @param {string} rgm
 * @returns {Promise<string[]>}
 */
export async function findOpenProtocolsByRgm(rgm) {
  const { rows } = await query(
    `select protocolo
       from caa_protocols
      where rgm = $1 and status = 'open'
      order by last_status_change_at desc`,
    [rgm]
  );
  return rows.map((r) => r.protocolo);
}

/**
 * Retorna info resumida dos snapshots CAA mais recentes (até `limit`).
 * @param {number} [limit]
 */
export async function listRecentSnapshots(limit = 5) {
  const { rows } = await query(
    `select id, file_name, row_count, created_at
       from processos_caa_snapshots
      order by created_at desc
      limit $1`,
    [limit]
  );
  return rows;
}

/**
 * Conta por status sobre TODOS os protocolos acumulados (estoque completo).
 */
export async function countByStatus() {
  const { rows } = await query(
    `select status, count(*)::int as n
       from caa_protocols
      group by status`
  );
  /** @type {Record<string, number>} */
  const out = { open: 0, lost_canceled: 0, lost_confirmed: 0, won_reverted: 0, unknown: 0 };
  for (const r of rows) out[r.status] = r.n;
  return out;
}
