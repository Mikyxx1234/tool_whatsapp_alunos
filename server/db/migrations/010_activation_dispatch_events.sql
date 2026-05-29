-- Histórico de ativações (permite contar 1ª, 2ª, 5ª… por categoria).

drop index if exists activation_dispatches_category_master_key_uidx;

create table if not exists activation_dispatch_events (
  id uuid primary key default gen_random_uuid(),
  category text not null,
  master_key text not null,
  status text not null check (status in ('sent', 'not_found', 'failed', 'skipped')),
  channel text not null default 'datacrazy',
  template_name text,
  message_tier text,
  datacrazy_lead_id text,
  nome text,
  telefone text,
  email text,
  rgm text,
  error_message text,
  created_at timestamptz not null default now(),
  constraint activation_dispatch_events_category_check check (
    category in ('docs-pendentes', 'acessos-blackboard', 'processos-caa')
  )
);

create index if not exists activation_dispatch_events_cat_key_idx
  on activation_dispatch_events (category, master_key);

create index if not exists activation_dispatch_events_cat_created_idx
  on activation_dispatch_events (category, created_at desc);

create index if not exists activation_dispatch_events_cat_status_idx
  on activation_dispatch_events (category, status);
