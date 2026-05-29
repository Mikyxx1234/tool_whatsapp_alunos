import { query } from '../db/client.js';

export async function listActive() {
  const { rows } = await query(
    `select id, code, name, description, is_active, created_at
       from campaign_types
       where is_active = true
       order by name`
  );
  return rows;
}

export async function findByCode(code) {
  const { rows } = await query(
    `select * from campaign_types where code = $1 limit 1`,
    [code]
  );
  return rows[0] || null;
}

export async function findById(id) {
  const { rows } = await query(
    `select * from campaign_types where id = $1 limit 1`,
    [id]
  );
  return rows[0] || null;
}
