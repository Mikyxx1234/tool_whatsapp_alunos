-- =============================================================================
-- Migration 032 — Base Inadimplentes Vencidos (mensalidade vencida / rematrícula)
-- =============================================================================

create table if not exists inadimplentes_vencidos_snapshots (
  id                uuid primary key default gen_random_uuid(),
  file_name         text not null,
  file_size_bytes   int,
  row_count         int not null default 0,
  created_at        timestamptz not null default now(),
  metadata          jsonb not null default '{}'::jsonb
);

create table if not exists inadimplentes_vencidos_rows (
  id            uuid primary key default gen_random_uuid(),
  snapshot_id   uuid not null references inadimplentes_vencidos_snapshots(id) on delete cascade,
  row_index     int not null,
  data          jsonb not null default '{}'::jsonb
);

create index if not exists idx_inadimplentes_vencidos_rows_snapshot
  on inadimplentes_vencidos_rows(snapshot_id);
create unique index if not exists uq_inadimplentes_vencidos_rows_order
  on inadimplentes_vencidos_rows(snapshot_id, row_index);
