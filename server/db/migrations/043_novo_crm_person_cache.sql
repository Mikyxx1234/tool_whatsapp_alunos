-- Espelho local pesquisável de contacts/deals do CRM EduIT.
-- O full noturno prioriza completude/gentileza no DB; a ativação usa este cache
-- para evitar GET /api/contacts?search=... pessoa a pessoa.

create table if not exists novo_crm_person_cache (
  contact_id           text primary key,
  primary_deal_id      text,
  contact_number       text,
  nome                 text,

  phone_norm           text,
  email_norm           text,
  cpf_norm             text,
  rgm_norm             text,

  raw_data             jsonb not null default '{}'::jsonb,
  filled_field_count   integer not null default 0,
  content_hash         text not null,
  source_updated_at    timestamptz,
  last_synced_at       timestamptz not null default now(),
  last_full_seen_at    timestamptz,
  is_deleted           boolean not null default false
);

create index if not exists idx_novo_crm_cache_phone
  on novo_crm_person_cache (phone_norm)
  where phone_norm is not null and is_deleted = false;

create index if not exists idx_novo_crm_cache_email
  on novo_crm_person_cache (email_norm)
  where email_norm is not null and is_deleted = false;

create index if not exists idx_novo_crm_cache_cpf
  on novo_crm_person_cache (cpf_norm)
  where cpf_norm is not null and is_deleted = false;

create index if not exists idx_novo_crm_cache_rgm
  on novo_crm_person_cache (rgm_norm)
  where rgm_norm is not null and is_deleted = false;

create index if not exists idx_novo_crm_cache_primary_deal
  on novo_crm_person_cache (primary_deal_id)
  where primary_deal_id is not null;

create index if not exists idx_novo_crm_cache_source_updated
  on novo_crm_person_cache (source_updated_at, contact_id);

create index if not exists idx_novo_crm_cache_full_seen
  on novo_crm_person_cache (last_full_seen_at)
  where is_deleted = false;

create table if not exists novo_crm_cache_sync_log (
  id                 bigserial primary key,
  mode               text not null check (mode in ('full', 'incremental')),
  started_at         timestamptz not null default now(),
  finished_at        timestamptz,
  cursor_started_at  timestamptz,
  cursor_finished_at timestamptz,
  contacts_total     integer,
  batches_scanned    integer not null default 0,
  contacts_seen      integer not null default 0,
  progress_updated_at timestamptz,
  cache_upserted     integer not null default 0,
  cache_skipped      integer not null default 0,
  contacts_deleted   integer not null default 0,
  data_loss_events   integer not null default 0,
  status             text not null default 'running' check (status in ('running', 'ok', 'error')),
  error_message      text
);

create index if not exists idx_novo_crm_cache_sync_log_started
  on novo_crm_cache_sync_log (started_at desc);

create table if not exists novo_crm_cache_sync_state (
  key               text primary key,
  cursor_updated_at timestamptz,
  cursor_id         text,
  updated_at        timestamptz not null default now()
);

insert into novo_crm_cache_sync_state (key)
values ('contacts_deals')
on conflict (key) do nothing;

create table if not exists novo_crm_data_loss_events (
  id                  bigserial primary key,
  contact_id          text not null,
  deal_id             text,
  field_paths         text[] not null,
  previous_values     jsonb not null default '{}'::jsonb,
  filled_count_before integer not null default 0,
  filled_count_after  integer not null default 0,
  previous_hash       text,
  next_hash           text,
  sync_log_id         bigint references novo_crm_cache_sync_log(id) on delete set null,
  fingerprint         text not null unique,
  detected_at         timestamptz not null default now(),
  acknowledged_at     timestamptz,
  acknowledged_by     text
);

create index if not exists idx_novo_crm_data_loss_open
  on novo_crm_data_loss_events (detected_at desc)
  where acknowledged_at is null;

create index if not exists idx_novo_crm_data_loss_contact
  on novo_crm_data_loss_events (contact_id, detected_at desc);
