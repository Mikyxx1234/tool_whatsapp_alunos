/**
 * One-shot backfill: preenche consultor, rgm, master_key, datacrazy_lead_id e
 * origem_ativacao faltantes em activation_responses.
 *
 * Usage: node scripts/backfill_response_identity.mjs [days] [category]
 *   days     : lookback em dias (default 90)
 *   category : filtrar por categoria (ex: processos-caa; default: todas)
 */
import pg from 'pg';
import { fileURLToPath } from 'url';
import { readFileSync } from 'fs';
import { join, dirname } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));

// Carrega .env manualmente (sem dotenv instalado globalmente)
try {
  const envPath = join(__dirname, '..', '.env');
  const lines = readFileSync(envPath, 'utf8').split('\n');
  for (const line of lines) {
    const m = line.match(/^([^#=]+)=(.*)$/);
    if (m) process.env[m[1].trim()] = m[2].trim();
  }
} catch {}

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) {
  console.error('DATABASE_URL não configurada');
  process.exit(1);
}

const days = parseInt(process.argv[2] || '90', 10);
const category = process.argv[3] || null;

const pool = new pg.Pool({
  connectionString: DATABASE_URL,
  ssl: process.env.DATABASE_SSL === 'true' ? { rejectUnauthorized: false } : false,
  max: 3,
});

async function q(sql, params = []) {
  const client = await pool.connect();
  try {
    return await client.query(sql, params);
  } finally {
    client.release();
  }
}

async function run() {
  console.log(`[backfill] days=${days} category=${category ?? '(todas)'}`);

  const categoryFilter = category ? 'and ar.category = $2' : '';
  const params = [days];
  if (category) params.push(category);

  // Step 0 — backfill datacrazy_lead_id de raw_payload->'Id do Lead'
  const r0 = await q(
    `update activation_responses ar
        set datacrazy_lead_id = nullif(trim(ar.raw_payload->>'Id do Lead'), '')
      where ar.datacrazy_lead_id is null
        and nullif(trim(ar.raw_payload->>'Id do Lead'), '') is not null
        and ar.received_at >= now() - ($1::int * interval '1 day')
        ${categoryFilter}`,
    params
  );
  console.log(`  lead_id_payload: ${r0.rowCount}`);

  // Step 1 — backfill consultor de raw_payload
  const r1 = await q(
    `update activation_responses ar
        set consultor_responsavel_nome = trim(both from coalesce(
              nullif(trim(ar.raw_payload->>'Consultor'), ''),
              nullif(trim(ar.raw_payload->>'consultor'), '')
            ))
      where nullif(trim(coalesce(ar.consultor_responsavel_nome, '')), '') is null
        and nullif(trim(coalesce(
              ar.raw_payload->>'Consultor',
              ar.raw_payload->>'consultor',
              ''
            )), '') is not null
        and ar.received_at >= now() - ($1::int * interval '1 day')
        ${categoryFilter}`,
    params
  );
  console.log(`  consultor: ${r1.rowCount}`);

  // Step 2 — backfill rgm de raw_payload->RGM/rgm
  const r2 = await q(
    `update activation_responses ar
        set rgm = nullif(regexp_replace(coalesce(ar.raw_payload->>'RGM', ar.raw_payload->>'rgm', ''), '[^0-9]', '', 'g'), ''),
            master_key = coalesce(
              nullif(trim(ar.master_key), ''),
              case
                when nullif(regexp_replace(coalesce(ar.raw_payload->>'RGM', ar.raw_payload->>'rgm', ''), '[^0-9]', '', 'g'), '') is not null
                then 'RGM:' || nullif(regexp_replace(coalesce(ar.raw_payload->>'RGM', ar.raw_payload->>'rgm', ''), '[^0-9]', '', 'g'), '')
                else ar.master_key
              end
            )
      where nullif(trim(coalesce(ar.rgm, '')), '') is null
        and length(regexp_replace(coalesce(ar.raw_payload->>'RGM', ar.raw_payload->>'rgm', ''), '[^0-9]', '', 'g')) >= 5
        and ar.received_at >= now() - ($1::int * interval '1 day')
        ${categoryFilter}`,
    params
  );
  console.log(`  rgm_payload: ${r2.rowCount}`);

  // Step 3 — backfill rgm via mv_aluno_por_telefone
  const r3 = await q(
    `update activation_responses ar
        set rgm = lk.rgm,
            master_key = coalesce(nullif(trim(ar.master_key), ''), 'RGM:' || lk.rgm)
       from mv_aluno_por_telefone lk
      where lk.phone_norm = normalize_phone_br(ar.telefone)
        and nullif(trim(coalesce(ar.rgm, '')), '') is null
        and nullif(trim(coalesce(lk.rgm, '')), '') is not null
        and ar.received_at >= now() - ($1::int * interval '1 day')
        ${categoryFilter}`,
    params
  );
  console.log(`  rgm_lk: ${r3.rowCount}`);

  // Step 4 — backfill rgm via activation_dispatch_events (match por telefone)
  const r4 = await q(
    `with candidates as (
       select ar.id,
              (
                select de.rgm
                  from activation_dispatch_events de
                 where de.status = 'sent'
                   and de.category = ar.category
                   and nullif(trim(coalesce(de.rgm, '')), '') is not null
                   and regexp_replace(coalesce(de.telefone, ''), '[^0-9]', '', 'g')
                       = regexp_replace(coalesce(ar.telefone, ''), '[^0-9]', '', 'g')
                   and de.created_at <= coalesce(ar.received_at, ar.created_at)
                   and de.created_at >= coalesce(ar.received_at, ar.created_at) - interval '72 hours'
                 order by de.created_at desc
                 limit 1
              ) as rgm
         from activation_responses ar
        where nullif(trim(coalesce(ar.rgm, '')), '') is null
          and ar.received_at >= now() - ($1::int * interval '1 day')
          ${categoryFilter}
     )
     update activation_responses ar
        set rgm = c.rgm,
            master_key = coalesce(nullif(trim(ar.master_key), ''), 'RGM:' || c.rgm)
       from candidates c
      where ar.id = c.id
        and c.rgm is not null`,
    params
  );
  console.log(`  rgm_dispatch: ${r4.rowCount}`);

  // Step 5 — backfill rgm via datacrazy_lead_cache → matriculados (por lead_id → CPF)
  const r5 = await q(
    `with matched as (
       select ar.id,
              nullif(trim(coalesce(
                mr.data->>'RGM', mr.data->>'Rgm', mr.data->>'Matricula', mr.data->>'matricula', ''
              )), '') as rgm
         from activation_responses ar
         join datacrazy_lead_cache dlc
           on dlc.datacrazy_lead_id = ar.datacrazy_lead_id
         join matriculados_rows mr
           on mr.snapshot_id = (
                select id from matriculados_snapshots order by created_at desc limit 1
              )
          and regexp_replace(coalesce(mr.data->>'CPF', mr.data->>'Cpf', mr.data->>'Cpf Aluno', ''), '[^0-9]', '', 'g')
              = regexp_replace(dlc.cpf, '[^0-9]', '', 'g')
        where nullif(trim(coalesce(ar.rgm, '')), '') is null
          and ar.datacrazy_lead_id is not null
          and ar.received_at >= now() - ($1::int * interval '1 day')
          ${categoryFilter}
        order by ar.id, mr.data->>'Data Matrícula' desc nulls last
     )
     update activation_responses ar
        set rgm = m.rgm,
            master_key = coalesce(nullif(trim(ar.master_key), ''), 'RGM:' || m.rgm)
       from (select distinct on (id) id, rgm from matched where rgm is not null) m
      where ar.id = m.id`,
    params
  );
  console.log(`  rgm_cache_lead_id: ${r5.rowCount}`);

  console.log('[backfill] concluído.');
}

run()
  .then(() => pool.end())
  .catch((err) => {
    console.error('[backfill] ERRO:', err.message);
    pool.end();
    process.exit(1);
  });
