-- =============================================================================
-- Migration 012 — Base Provável evasão (snapshot + linhas)
-- =============================================================================

create table if not exists provavel_evasao_snapshots (
  id                uuid primary key default gen_random_uuid(),
  file_name         text not null,
  file_size_bytes   int,
  row_count         int not null default 0,
  created_at        timestamptz not null default now(),
  metadata          jsonb not null default '{}'::jsonb
);

create table if not exists provavel_evasao_rows (
  id            uuid primary key default gen_random_uuid(),
  snapshot_id   uuid not null references provavel_evasao_snapshots(id) on delete cascade,
  row_index     int not null,
  data          jsonb not null default '{}'::jsonb
);

create index if not exists idx_provavel_evasao_rows_snapshot on provavel_evasao_rows(snapshot_id);
create unique index if not exists uq_provavel_evasao_rows_order on provavel_evasao_rows(snapshot_id, row_index);
