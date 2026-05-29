import pg from 'pg';

let pool = null;

/**
 * Retorna o Pool do pg (singleton).
 * Lê DATABASE_URL do .env. Em Supabase/RDS, ative DATABASE_SSL=true.
 */
export function getPool() {
  if (pool) return pool;

  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    throw new Error(
      'DATABASE_URL não configurada. Defina no .env para usar funcionalidades de banco.'
    );
  }

  const useSsl =
    String(process.env.DATABASE_SSL || '').toLowerCase() === 'true' ||
    /supabase\.co|amazonaws\.com|render\.com/i.test(connectionString);

  pool = new pg.Pool({
    connectionString,
    ssl: useSsl ? { rejectUnauthorized: false } : false,
    max: Number(process.env.DATABASE_POOL_MAX) || 10,
    idleTimeoutMillis: 30000,
  });

  pool.on('error', (err) => {
    console.error('[db] erro no pool:', err);
  });

  return pool;
}

/**
 * Helper para queries simples. Prefira `withTransaction` quando precisar de
 * transação atômica.
 */
export async function query(text, params) {
  const p = getPool();
  return p.query(text, params);
}

/**
 * Executa o callback dentro de uma transação. Faz rollback automático se a
 * função lançar exceção.
 */
export async function withTransaction(callback) {
  const p = getPool();
  const client = await p.connect();
  try {
    await client.query('BEGIN');
    const result = await callback(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    try {
      await client.query('ROLLBACK');
    } catch (rollbackErr) {
      console.error('[db] erro no rollback:', rollbackErr);
    }
    throw err;
  } finally {
    client.release();
  }
}

export function isDbConfigured() {
  return Boolean(process.env.DATABASE_URL);
}
