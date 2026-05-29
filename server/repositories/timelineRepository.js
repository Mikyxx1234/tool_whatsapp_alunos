import { query } from '../db/client.js';

const FIELDS = `id, student_id, event_type, title, description, metadata, created_at`;

/**
 * Registra um evento na timeline do aluno.
 * Sempre persiste — falhas no repo NÃO devem propagar para o caller principal
 * (use try/catch no caller se for crítico).
 */
export async function record(input, client) {
  const exec = client ? client.query.bind(client) : query;
  const { rows } = await exec(
    `insert into student_timeline_events
       (student_id, event_type, title, description, metadata)
     values ($1, $2, $3, $4, $5)
     returning ${FIELDS}`,
    [
      input.studentId || input.student_id,
      input.eventType || input.event_type,
      input.title || null,
      input.description || null,
      input.metadata ? JSON.stringify(input.metadata) : null,
    ]
  );
  return rows[0];
}

export async function listByStudent(studentId, { limit = 200 } = {}) {
  const { rows } = await query(
    `select ${FIELDS} from student_timeline_events
       where student_id = $1
       order by created_at desc
       limit $2`,
    [studentId, limit]
  );
  return rows;
}
