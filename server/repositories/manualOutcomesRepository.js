import { query } from '../db/client.js';

/**
 * @typedef {Object} ManualOutcomeRow
 * @property {string} id
 * @property {string} category
 * @property {string|null} master_key
 * @property {string|null} rgm
 * @property {string|null} cpf
 * @property {string|null} nome
 * @property {string|null} protocolo
 * @property {'revertido'|'confirmado'|'sem_contato'|'outro'} outcome
 * @property {string|null} motivo
 * @property {string|null} notes
 * @property {string|null} proof_path
 * @property {string|null} proof_mime
 * @property {number|null} proof_size_bytes
 * @property {string} consultor_nome
 * @property {string} occurred_at
 * @property {string} created_at
 */

/**
 * @param {{
 *   category: string,
 *   master_key?: string|null,
 *   rgm?: string|null,
 *   cpf?: string|null,
 *   nome?: string|null,
 *   protocolo?: string|null,
 *   outcome: string,
 *   motivo?: string|null,
 *   notes?: string|null,
 *   consultor_nome: string,
 *   occurred_at?: Date|string|null,
 * }} data
 * @returns {Promise<ManualOutcomeRow>}
 */
export async function insertOutcome(data) {
  const { rows } = await query(
    `insert into activation_manual_outcomes
       (category, master_key, rgm, cpf, nome, protocolo, outcome,
        motivo, notes, consultor_nome, occurred_at)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
     returning *`,
    [
      data.category,
      data.master_key ?? null,
      data.rgm ?? null,
      data.cpf ?? null,
      data.nome ?? null,
      data.protocolo ?? null,
      data.outcome,
      data.motivo ?? null,
      data.notes ?? null,
      data.consultor_nome,
      data.occurred_at ? new Date(data.occurred_at) : new Date(),
    ]
  );
  return rows[0];
}

/**
 * @param {string} id
 * @returns {Promise<ManualOutcomeRow|null>}
 */
export async function findById(id) {
  const { rows } = await query(
    `select * from activation_manual_outcomes where id = $1`,
    [id]
  );
  return rows[0] ?? null;
}

/**
 * @param {{
 *   category?: string,
 *   rgm?: string,
 *   outcome?: string,
 *   consultor?: string,
 *   from?: string,
 *   to?: string,
 *   limit?: string|number,
 *   offset?: string|number,
 * }} filters
 * @returns {Promise<ManualOutcomeRow[]>}
 */
export async function listOutcomes(filters = {}) {
  const params = [];
  const wheres = [];

  if (filters.category) {
    params.push(filters.category);
    wheres.push(`category = $${params.length}`);
  }
  if (filters.rgm) {
    params.push(filters.rgm);
    wheres.push(`rgm = $${params.length}`);
  }
  if (filters.outcome) {
    params.push(filters.outcome);
    wheres.push(`outcome = $${params.length}`);
  }
  if (filters.consultor) {
    params.push(`%${filters.consultor}%`);
    wheres.push(`consultor_nome ilike $${params.length}`);
  }
  if (filters.from) {
    params.push(new Date(filters.from));
    wheres.push(`occurred_at >= $${params.length}`);
  }
  if (filters.to) {
    params.push(new Date(filters.to));
    wheres.push(`occurred_at <= $${params.length}`);
  }
  if (filters.search) {
    params.push(`%${filters.search}%`);
    wheres.push(`(rgm ilike $${params.length} or nome ilike $${params.length})`);
  }

  const where = wheres.length ? `where ${wheres.join(' and ')}` : '';
  const limit = Math.min(Math.max(parseInt(String(filters.limit ?? '100'), 10) || 100, 1), 500);
  const offset = Math.max(parseInt(String(filters.offset ?? '0'), 10) || 0, 0);
  params.push(limit, offset);

  const { rows } = await query(
    `select id, category, master_key, rgm, cpf, nome, protocolo,
            outcome, motivo, notes,
            proof_path is not null as has_proof,
            proof_mime, proof_size_bytes,
            consultor_nome, occurred_at, created_at
       from activation_manual_outcomes
      ${where}
      order by occurred_at desc
      limit $${params.length - 1} offset $${params.length}`,
    params
  );
  return rows;
}

/**
 * @param {string} id
 * @param {{ proof_path: string, proof_mime: string, proof_size_bytes: number }} data
 * @returns {Promise<ManualOutcomeRow|null>}
 */
export async function updateProof(id, { proof_path, proof_mime, proof_size_bytes }) {
  const { rows } = await query(
    `update activation_manual_outcomes
        set proof_path = $2, proof_mime = $3, proof_size_bytes = $4
      where id = $1
      returning *`,
    [id, proof_path, proof_mime, proof_size_bytes]
  );
  return rows[0] ?? null;
}

/**
 * @param {string} id
 * @returns {Promise<{ id: string, proof_path: string|null }|null>}
 */
export async function clearProof(id) {
  const { rows } = await query(
    `update activation_manual_outcomes
        set proof_path = null, proof_mime = null, proof_size_bytes = null
      where id = $1
      returning id, proof_path`,
    [id]
  );
  return rows[0] ?? null;
}

/**
 * @param {string} id
 * @returns {Promise<{ id: string, proof_path: string|null }|null>}
 */
export async function deleteById(id) {
  const { rows } = await query(
    `delete from activation_manual_outcomes where id = $1
     returning id, proof_path`,
    [id]
  );
  return rows[0] ?? null;
}

/**
 * Remove todos os desfechos de um RGM numa categoria.
 * Retorna a lista de ids deletados (com proof_path para limpeza de arquivo se necessário).
 * @param {string} rgm
 * @param {string} category
 * @returns {Promise<Array<{ id: string, proof_path: string|null }>>}
 */
export async function deleteByRgmAndCategory(rgm, category) {
  const { rows } = await query(
    `delete from activation_manual_outcomes
      where rgm = $1 and category = $2
      returning id, proof_path`,
    [rgm, category]
  );
  return rows;
}

/**
 * Insere desfecho originado do sync do CRM (sem proof, consultor automático).
 * @param {{
 *   category: string,
 *   rgm?: string|null,
 *   datacrazy_lead_id?: string|null,
 *   nome?: string|null,
 *   outcome: string,
 *   motivo?: string|null,
 *   notes?: string|null,
 *   occurred_at?: Date|string|null,
 * }} data
 * @returns {Promise<ManualOutcomeRow>}
 */
export async function createFromCrm(data) {
  const masterKey = data.rgm ? `RGM:${data.rgm}` : null;
  return insertOutcome({
    category: data.category,
    master_key: masterKey,
    rgm: data.rgm ?? null,
    cpf: null,
    nome: data.nome ?? null,
    protocolo: null,
    outcome: data.outcome,
    motivo: data.motivo ?? null,
    notes: data.notes ?? null,
    consultor_nome: 'DataCrazy CRM (auto)',
    occurred_at: data.occurred_at ?? new Date(),
  });
}
