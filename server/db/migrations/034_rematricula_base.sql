-- Base Rematrícula: uploads SIAA e Portal de Polos (usa o mais recente para inadimplentes).

create table if not exists rematricula_snapshots (
  id                uuid primary key default gen_random_uuid(),
  source            text not null check (source in ('siaa', 'portal-de-polos')),
  file_name         text not null,
  file_size_bytes   int,
  row_count         int not null default 0,
  created_at        timestamptz not null default now(),
  metadata          jsonb not null default '{}'::jsonb
);

create index if not exists idx_rematricula_snapshots_created
  on rematricula_snapshots (created_at desc);
create index if not exists idx_rematricula_snapshots_source_created
  on rematricula_snapshots (source, created_at desc);

create table if not exists rematricula_rows (
  id            uuid primary key default gen_random_uuid(),
  snapshot_id   uuid not null references rematricula_snapshots(id) on delete cascade,
  row_index     int not null,
  data          jsonb not null default '{}'::jsonb
);

create index if not exists idx_rematricula_rows_snapshot
  on rematricula_rows(snapshot_id);
create unique index if not exists uq_rematricula_rows_order
  on rematricula_rows(snapshot_id, row_index);
