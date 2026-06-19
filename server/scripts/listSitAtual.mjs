/**
 * Lista valores distintos de Sit_Atual no upload SIAA (DB + ZIP local).
 */
import 'dotenv/config';
import pg from 'pg';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { zipBufferToRowObjects } from '../utils/siaaZipImport.js';

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });

function sitFromRow(row) {
  return String(row.Sit_Atual ?? row.SIT_ATUAL ?? '').trim() || '(vazio)';
}

function countBySit(rows) {
  const m = new Map();
  for (const r of rows) {
    const s = sitFromRow(r).toUpperCase();
    m.set(s, (m.get(s) || 0) + 1);
  }
  return [...m.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([sit, n]) => ({ sit, n }));
}

async function fromDb() {
  const snap = await pool.query(`
    SELECT id, file_name, row_count, created_at
    FROM rematricula_snapshots
    WHERE source = 'siaa'
    ORDER BY created_at DESC
    LIMIT 1
  `);
  if (!snap.rows.length) return null;
  const { id, file_name, row_count, created_at } = snap.rows[0];
  const counts = await pool.query(
    `
    SELECT
      COALESCE(NULLIF(TRIM(data->>'Sit_Atual'), ''), NULLIF(TRIM(data->>'SIT_ATUAL'), ''), '(vazio)') AS sit,
      COUNT(*)::int AS n
    FROM rematricula_rows
    WHERE snapshot_id = $1
    GROUP BY 1
    ORDER BY n DESC
  `,
    [id]
  );
  return { file_name, row_count, created_at, counts: counts.rows };
}

async function fromZip() {
  const zipPath = path.join(
    process.env.USERPROFILE || '',
    'Downloads',
    'excel__16062026-111255.zip'
  );
  if (!fs.existsSync(zipPath)) return null;
  const buf = fs.readFileSync(zipPath);
  const fileName = path.basename(zipPath);
  const all = zipBufferToRowObjects(buf, fileName, { siaaInadimplenteOnly: false });
  const inad = zipBufferToRowObjects(buf, fileName, { siaaInadimplenteOnly: true });
  return {
    file_name: fileName,
    all_rows: all.length,
    inadimplente_rows: inad.length,
    all_sit_atual: countBySit(all),
    inad_sit_atual: countBySit(inad),
  };
}

try {
  const [db, zip] = await Promise.all([fromDb(), fromZip()]);
  console.log(JSON.stringify({ db, zip }, null, 2));
} finally {
  await pool.end();
}
