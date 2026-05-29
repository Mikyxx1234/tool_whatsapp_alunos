import { query, withTransaction } from '../db/client.js';

const FIELDS = `
  id, student_id, campaign_id, template_id, canal, event_type, execution_date,
  status, attempts, max_attempts, last_error, locked_at, processed_at, metadata,
  created_at, updated_at
`;

/**
 * Insere uma lista de eventos agendados (geração da régua).
 * Aceita inputs com chaves camelCase ou snake_case.
 */
export async function bulkInsert(events, client) {
  if (!Array.isArray(events) || events.length === 0) return [];
  const inserter = async (cli) => {
    const out = [];
    for (const e of events) {
      const { rows } = await cli.query(
        `insert into scheduled_events
           (student_id, campaign_id, template_id, canal, event_type,
            execution_date, status, max_attempts, metadata)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9)
         returning ${FIELDS}`,
        [
          e.student_id || e.studentId,
          e.campaign_id || e.campaignId || null,
          e.template_id || e.templateId || null,
          e.canal,
          e.event_type || e.eventType || null,
          e.execution_date || e.executionDate,
          e.status || 'pending',
          e.max_attempts || e.maxAttempts || 3,
          e.metadata ? JSON.stringify(e.metadata) : null,
        ]
      );
      out.push(rows[0]);
    }
    return out;
  };
  if (client) return inserter(client);
  return withTransaction(inserter);
}

/**
 * Reivindica atomicamente até `limit` eventos pendentes para processamento.
 * Usa FOR UPDATE SKIP LOCKED para que múltiplas instâncias coexistam.
 *
 * Retorna a lista de eventos travados (status = 'processing', locked_at = now()).
 */
export async function claimBatch(limit = 50, client) {
  const exec = client ? client.query.bind(client) : query;
  const { rows } = await exec(
    `update scheduled_events
        set status = 'processing',
            locked_at = now(),
            attempts = attempts + 1
      where id in (
        select id from scheduled_events
         where status = 'pending'
           and execution_date <= now()
         order by execution_date asc
         limit $1
         for update skip locked
      )
      returning ${FIELDS}`,
    [limit]
  );
  return rows;
}

/**
 * Libera locks que ficaram presos por mais de N minutos (proteção contra
 * crash durante o processamento).
 */
export async function releaseStaleLocks(staleMinutes = 10, client) {
  const exec = client ? client.query.bind(client) : query;
  const { rowCount } = await exec(
    `update scheduled_events
        set status = 'pending', locked_at = null
      where status = 'processing'
        and locked_at is not null
        and locked_at < now() - ($1 || ' minutes')::interval`,
    [String(staleMinutes)]
  );
  return rowCount;
}

export async function markSent(id, { providerMessageId } = {}, client) {
  const exec = client ? client.query.bind(client) : query;
  const { rows } = await exec(
    `update scheduled_events
        set status = 'sent',
            processed_at = now(),
            last_error = null,
            metadata = coalesce(metadata, '{}'::jsonb) ||
                       jsonb_build_object('providerMessageId', $2::text)
      where id = $1
      returning ${FIELDS}`,
    [id, providerMessageId || null]
  );
  return rows[0] || null;
}

/**
 * Em caso de falha, decide se faz retry (volta pra pending com nova
 * execution_date) ou marca como failed definitivo.
 */
export async function markFailureOrRetry(id, errorMessage, client) {
  const exec = client ? client.query.bind(client) : query;
  const { rows: cur } = await exec(
    `select id, attempts, max_attempts from scheduled_events where id = $1`,
    [id]
  );
  const event = cur[0];
  if (!event) return null;

  if (event.attempts < event.max_attempts) {
    // backoff: 15min * tentativas restantes
    const backoffMinutes = 15 * event.attempts;
    const { rows } = await exec(
      `update scheduled_events
          set status = 'pending',
              last_error = $2,
              locked_at = null,
              execution_date = now() + ($3 || ' minutes')::interval
        where id = $1
        returning ${FIELDS}`,
      [id, errorMessage, String(backoffMinutes)]
    );
    return { event: rows[0], retried: true };
  }

  const { rows } = await exec(
    `update scheduled_events
        set status = 'failed',
            processed_at = now(),
            last_error = $2,
            locked_at = null
      where id = $1
      returning ${FIELDS}`,
    [id, errorMessage]
  );
  return { event: rows[0], retried: false };
}

export async function cancelById(id, reason, client) {
  const exec = client ? client.query.bind(client) : query;
  const { rows } = await exec(
    `update scheduled_events
        set status = 'cancelled',
            processed_at = now(),
            last_error = $2
      where id = $1 and status in ('pending','processing')
      returning ${FIELDS}`,
    [id, reason || null]
  );
  return rows[0] || null;
}

export async function cancelFutureForStudent(studentId, reason, client) {
  const exec = client ? client.query.bind(client) : query;
  const { rowCount } = await exec(
    `update scheduled_events
        set status = 'cancelled',
            processed_at = now(),
            last_error = $2
      where student_id = $1
        and status in ('pending','processing')`,
    [studentId, reason || null]
  );
  return rowCount;
}

export async function listByStudent(studentId, { limit = 200 } = {}) {
  const { rows } = await query(
    `select ${FIELDS} from scheduled_events
       where student_id = $1
       order by execution_date asc
       limit $2`,
    [studentId, limit]
  );
  return rows;
}

export async function list({ status, studentId, from, to, limit = 100, offset = 0 } = {}) {
  const conditions = [];
  const params = [];
  if (status) {
    params.push(status);
    conditions.push(`status = $${params.length}`);
  }
  if (studentId) {
    params.push(studentId);
    conditions.push(`student_id = $${params.length}`);
  }
  if (from) {
    params.push(from);
    conditions.push(`execution_date >= $${params.length}`);
  }
  if (to) {
    params.push(to);
    conditions.push(`execution_date <= $${params.length}`);
  }
  const where = conditions.length ? `where ${conditions.join(' and ')}` : '';
  params.push(limit);
  params.push(offset);
  const { rows } = await query(
    `select ${FIELDS} from scheduled_events ${where}
       order by execution_date asc
       limit $${params.length - 1} offset $${params.length}`,
    params
  );
  return rows;
}
