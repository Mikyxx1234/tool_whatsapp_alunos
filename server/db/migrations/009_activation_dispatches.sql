-- Registro de ativações já realizadas por categoria (docs / BB / CAA são independentes).

create table if not exists activation_dispatches (
  id uuid primary key default gen_random_uuid(),
  category text not null,
  master_key text not null,
  dispatched_at timestamptz not null default now(),
  matriculados_snapshot_id uuid,
  other_snapshot_id uuid,
  metadata jsonb not null default '{}'::jsonb,
  constraint activation_dispatches_category_check check (
    category in ('docs-pendentes', 'acessos-blackboard', 'processos-caa')
  )
);

create unique index if not exists activation_dispatches_category_master_key_uidx
  on activation_dispatches (category, master_key);

create index if not exists activation_dispatches_category_dispatched_at_idx
  on activation_dispatches (category, dispatched_at desc);
