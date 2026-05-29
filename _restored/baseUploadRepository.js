import Papa from 'papaparse';
import { query, withTransaction } from '../db/client.js';

/** @typedef {'matriculados'|'docs-pendentes'|'financeiro'|'acessos-blackboard'|'processos-caa'} BaseCategory */

const TABLES = {
  matriculados: { snapshots: 'matriculados_snapshots', rows: 'matriculados_rows' },
  'docs-pendentes': { snapshots: 'docs_pendentes_snapshots', rows: 'docs_pendentes_rows' },
  financeiro: { snapshots: 'financeiro_snapshots', rows: 'financeiro_rows' },
  'acessos-blackboard': { snapshots: 'acessos_blackboard_snapshots', rows: 'acessos_blackboard_rows' },
  'processos-caa': { snapshots: 'processos_caa_snapshots', rows: 'processos_caa_rows' },
};

const MAX_ROWS_PER_UPLOAD = 50_000;

/**
 * @param {string} category
 * @returns {{ snapshots: string, rows: string }}
 */
export function resolveTables(category) {
  const t = TABLES[category];
  if (!t) {
    const err = new Error(`Categoria inválida: ${category}`);
    err.status = 400;
    throw err;
  }
  return t;
}

/**
 * @param {string} csvText
 * @returns {Record<string, string>[]}
 */
export function csvTextToRowObjects(csvText) {
  const parsed = Papa.parse(String(csvText || ''), {
    header: true,
    skipEmptyLines: 'greedy',
  });
  if (parsed.errors?.length) {
    const msg = parsed.errors.map((e) => e.message).join('; ');
    const err = new Error(`CSV: ${msg}`);
    err.status = 400;
    throw err;
  }
  const data = parsed.data || [];
  return data.map((row) => {
    /** @type {Record<string, string>} */
    const o = {};
    if (row && typeof row === 'object') {
      for (const [k, v] of Object.entries(row)) {
        o[k] = v === null || v === undefined ? '' : String(v);
      }
    }
    return o;
  });
}

/**
 * @param {string} category
 * @param {{ fileName: string, fileSizeBytes?: number|null, csvText: string, metadata?: object }} input
 */
export async function createSnapshotFromCsv(category, input) {
  const { snapshots: st, rows: rt } = resolveTables(category);
  const objects = csvTextToRowObjects(input.csvText);
  if (objects.length > MAX_ROWS_PER_UPLOAD) {
    const err = new Error(`Limite de ${MAX_ROWS_PER_UPLOAD.toLocaleString('pt-BR')} linhas por upload.`);
    err.status = 400;
    throw err;
  }
  const meta = input.metadata && typeof input.metadata === 'object' ? input.metadata : {};
  const fileName = String(input.fileName || 'upload.csv').slice(0, 512);

  return withTransaction(async (client) => {
    const ins = await client.query(
      `insert into ${st} (file_name, file_size_bytes, row_count, metadata)
       values ($1, $2, $3, $4::jsonb)
       returning id, file_name, file_size_bytes, row_count, created_at, metadata`,
      [
        fileName,
        input.fileSizeBytes ?? null,
        objects.length,
        JSON.stringify(meta),
      ]
    );
    const snap = ins.rows[0];
    const snapshotId = snap.id;

    const CHUNK = 150;
    for (let i = 0; i < objects.length; i += CHUNK) {
      const slice = objects.slice(i, i + CHUNK);
      const valueParts = [];
      const params = [];
      let p = 1;
      for (let j = 0; j < slice.length; j += 1) {
        valueParts.push(`($${p++}::uuid, $${p++}::int, $${p++}::jsonb)`);
        params.push(snapshotId, i + j, JSON.stringify(slice[j]));
      }
      await client.query(
        `insert into ${rt} (snapshot_id, row_index, data) values ${valueParts.join(', ')}`,
        params
      );
    }

    return { snapshot: snap, rowCount: objects.length };
  });
}

/**
 * @param {string} category
 * @param {{ limit?: number }} opts
 */
export async function listSnapshots(category, { limit = 80 } = {}) {
  const { snapshots: st } = resolveTables(category);
  const lim = Math.min(Math.max(Number(limit) || 80, 1), 200);
  const { rows } = await query(
    `select id, file_name, file_size_bytes, row_count, created_at, metadata
       from ${st}
      order by created_at desc
      limit $1`,
    [lim]
  );
  return rows;
}

/**
 * @param {string} category
 * @param {string} snapshotId
 */
export async function getSnapshot(category, snapshotId) {
  const { snapshots: st } = resolveTables(category);
  const { rows } = await query(
    `select id, file_name, file_size_bytes, row_count, created_at, metadata
       from ${st} where id = $1 limit 1`,
    [snapshotId]
  );
  return rows[0] || null;
}

/**
 * @param {string} category
 * @param {string} snapshotId
 * @param {{ limit?: number, offset?: number }} opts
 */
export async function listRows(category, snapshotId, { limit = 200, offset = 0 } = {}) {
  const { rows: rt } = resolveTables(category);
  const lim = Math.min(Math.max(Number(limit) || 200, 1), 500);
  const off = Math.max(Number(offset) || 0, 0);
  const [{ rows }, { rows: countRows }] = await Promise.all([
    query(
      `select id, row_index, data from ${rt}
        where snapshot_id = $1
        order by row_index asc
        limit $2 offset $3`,
      [snapshotId, lim, off]
    ),
    query(`select count(*)::int as n from ${rt} where snapshot_id = $1`, [snapshotId]),
  ]);
  return { rows, total: countRows[0]?.n ?? 0 };
}

/**
 * @param {string} category
 * @param {string} snapshotId
 */
export async function deleteSnapshot(category, snapshotId) {
  const { snapshots: st } = resolveTables(category);
  const { rowCount } = await query(`delete from ${st} where id = $1`, [snapshotId]);
  return rowCount;
}
