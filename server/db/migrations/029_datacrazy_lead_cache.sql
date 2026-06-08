-- Cache local cpf → datacrazy_lead_id pra evitar varredura da API CRM
-- a cada disparo. Populado por cron diário e por hits oportunistas.
create table if not exists datacrazy_lead_cache (
  cpf              text primary key,
  datacrazy_lead_id text not null,
  email_norm       text,
  phone_norm       text,
  nome             text,
  raw_lead         jsonb,
  source           text not null default 'sync',
  last_synced_at   timestamptz not null default now(),
  last_seen_at     timestamptz not null default now()
);

create index if not exists idx_dlc_email_norm on datacrazy_lead_cache (email_norm) where email_norm is not null;
create index if not exists idx_dlc_phone_norm on datacrazy_lead_cache (phone_norm) where phone_norm is not null;
create index if not exists idx_dlc_last_synced on datacrazy_lead_cache (last_synced_at);

create table if not exists datacrazy_lead_cache_sync_log (
  id              bigserial primary key,
  started_at      timestamptz not null default now(),
  finished_at     timestamptz,
  pages_scanned   integer not null default 0,
  leads_seen      integer not null default 0,
  leads_upserted  integer not null default 0,
  leads_skipped   integer not null default 0,
  error_message   text,
  status          text not null default 'running'
);
