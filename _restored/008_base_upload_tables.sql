-- =============================================================================
-- Migration 008 — Bases de upload (snapshot + linhas) por categoria
-- =============================================================================
-- Uma dupla de tabelas por tipo de base, para consulta no Easypanel / SQL:
--   *_snapshots  → metadados de cada arquivo/importação
--   *_rows       → todas as linhas (data jsonb: colunas do CSV)
-- =============================================================================

-- Matriculados
create table if not exists matriculados_snapshots (
  id                uuid primary key default gen_random_uuid(),
  file_name         text not null,
  file_size_bytes   int,
  row_count         int not null default 0,
  created_at        timestamptz not null default now(),
  metadata          jsonb not null default '{}'::jsonb
);
create table if not exists matriculados_rows (
  id            uuid primary key default gen_random_uuid(),
  snapshot_id   uuid not null references matriculados_snapshots(id) on delete cascade,
  row_index     int not null,
  data          jsonb not null default '{}'::jsonb
);
create index if not exists idx_matriculados_rows_snapshot on matriculados_rows(snapshot_id);
create unique index if not exists uq_matriculados_rows_order on matriculados_rows(snapshot_id, row_index);

-- Alunos docs. pendentes
create table if not exists docs_pendentes_snapshots (
  id                uuid primary key default gen_random_uuid(),
  file_name         text not null,
  file_size_bytes   int,
  row_count         int not null default 0,
  created_at        timestamptz not null default now(),
  metadata          jsonb not null default '{}'::jsonb
);
create table if not exists docs_pendentes_rows (
  id            uuid primary key default gen_random_uuid(),
  snapshot_id   uuid not null references docs_pendentes_snapshots(id) on delete cascade,
  row_index     int not null,
  data          jsonb not null default '{}'::jsonb
);
create index if not exists idx_docs_pendentes_rows_snapshot on docs_pendentes_rows(snapshot_id);
create unique index if not exists uq_docs_pendentes_rows_order on docs_pendentes_rows(snapshot_id, row_index);

-- Financeiro
create table if not exists financeiro_snapshots (
  id                uuid primary key default gen_random_uuid(),
  file_name         text not null,
  file_size_bytes   int,
  row_count         int not null default 0,
  created_at        timestamptz not null default now(),
  metadata          jsonb not null default '{}'::jsonb
);
create table if not exists financeiro_rows (
  id            uuid primary key default gen_random_uuid(),
  snapshot_id   uuid not null references financeiro_snapshots(id) on delete cascade,
  row_index     int not null,
  data          jsonb not null default '{}'::jsonb
);
create index if not exists idx_financeiro_rows_snapshot on financeiro_rows(snapshot_id);
create unique index if not exists uq_financeiro_rows_order on financeiro_rows(snapshot_id, row_index);

-- Acessos Blackboard
create table if not exists acessos_blackboard_snapshots (
  id                uuid primary key default gen_random_uuid(),
  file_name         text not null,
  file_size_bytes   int,
  row_count         int not null default 0,
  created_at        timestamptz not null default now(),
  metadata          jsonb not null default '{}'::jsonb
);
create table if not exists acessos_blackboard_rows (
  id            uuid primary key default gen_random_uuid(),
  snapshot_id   uuid not null references acessos_blackboard_snapshots(id) on delete cascade,
  row_index     int not null,
  data          jsonb not null default '{}'::jsonb
);
create index if not exists idx_acessos_blackboard_rows_snapshot on acessos_blackboard_rows(snapshot_id);
create unique index if not exists uq_acessos_blackboard_rows_order on acessos_blackboard_rows(snapshot_id, row_index);

-- Processos CAA
create table if not exists processos_caa_snapshots (
  id                uuid primary key default gen_random_uuid(),
  file_name         text not null,
  file_size_bytes   int,
  row_count         int not null default 0,
  created_at        timestamptz not null default now(),
  metadata          jsonb not null default '{}'::jsonb
);
create table if not exists processos_caa_rows (
  id            uuid primary key default gen_random_uuid(),
  snapshot_id   uuid not null references processos_caa_snapshots(id) on delete cascade,
  row_index     int not null,
  data          jsonb not null default '{}'::jsonb
);
create index if not exists idx_processos_caa_rows_snapshot on processos_caa_rows(snapshot_id);
create unique index if not exists uq_processos_caa_rows_order on processos_caa_rows(snapshot_id, row_index);
