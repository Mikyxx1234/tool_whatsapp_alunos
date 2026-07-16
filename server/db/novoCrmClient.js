import pg from 'pg';
import { isNovoCrmConfigured } from '../utils/crmFonte.js';

let pool = null;

/**
 * Pool Postgres do CRM EduIT (leitura Painel / tabulações / campanhas).
 * Env: NOVO_CRM_DATABASE_URL (+ NOVO_CRM_ENABLED=1).
 */
export function getNovoCrmPool() {
  if (pool) return pool;

  const connectionString = String(process.env.NOVO_CRM_DATABASE_URL || '').trim();
  if (!connectionString) {
    throw new Error(
      'NOVO_CRM_DATABASE_URL não configurada. Defina no .env para ler o Postgres do CRM.'
    );
  }

  const useSsl =
    String(process.env.NOVO_CRM_DATABASE_SSL || process.env.DATABASE_SSL || '')
      .toLowerCase() === 'true' ||
    /supabase\.co|amazonaws\.com|render\.com/i.test(connectionString);

  pool = new pg.Pool({
    connectionString,
    ssl: useSsl ? { rejectUnauthorized: false } : false,
    max: Number(process.env.NOVO_CRM_DATABASE_POOL_MAX) || 5,
    idleTimeoutMillis: 30000,
  });

  pool.on('error', (err) => {
    console.error('[novo-crm-db] erro no pool:', err);
  });

  return pool;
}

export function isNovoCrmDbConfigured() {
  return isNovoCrmConfigured();
}

export async function novoCrmQuery(text, params) {
  const p = getNovoCrmPool();
  return p.query(text, params);
}
