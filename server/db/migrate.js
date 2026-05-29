import 'dotenv/config';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getPool } from './client.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = path.join(__dirname, 'migrations');

async function ensureMigrationsTable(client) {
  await client.query(`
    create table if not exists _migrations (
      id serial primary key,
      filename text unique not null,
      applied_at timestamptz not null default now()
    );
  `);
}

async function getApplied(client) {
  const { rows } = await client.query('select filename from _migrations');
  return new Set(rows.map((r) => r.filename));
}

async function listMigrationFiles() {
  const entries = await fs.readdir(MIGRATIONS_DIR);
  return entries
    .filter((f) => f.endsWith('.sql'))
    .sort();
}

async function applyMigration(client, filename) {
  const fullPath = path.join(MIGRATIONS_DIR, filename);
  const sql = await fs.readFile(fullPath, 'utf8');
  console.log(`[migrate] aplicando ${filename}...`);
  await client.query('BEGIN');
  try {
    await client.query(sql);
    await client.query(
      'insert into _migrations (filename) values ($1)',
      [filename]
    );
    await client.query('COMMIT');
    console.log(`[migrate]   ✔ ${filename}`);
  } catch (err) {
    await client.query('ROLLBACK');
    console.error(`[migrate]   ✘ ${filename}:`, err.message);
    throw err;
  }
}

async function main() {
  if (!process.env.DATABASE_URL) {
    console.error('[migrate] DATABASE_URL não configurada. Abortando.');
    process.exit(1);
  }

  const pool = getPool();
  const client = await pool.connect();
  try {
    await ensureMigrationsTable(client);
    const applied = await getApplied(client);
    const files = await listMigrationFiles();
    const pending = files.filter((f) => !applied.has(f));

    if (pending.length === 0) {
      console.log('[migrate] nada a aplicar. banco já está atualizado.');
      return;
    }

    console.log(`[migrate] ${pending.length} migration(s) pendente(s).`);
    for (const f of pending) {
      await applyMigration(client, f);
    }
    console.log('[migrate] concluído.');
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch((err) => {
  console.error('[migrate] erro fatal:', err);
  process.exit(1);
});
