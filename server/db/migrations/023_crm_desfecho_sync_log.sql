create table if not exists crm_desfecho_sync_log (
  id uuid primary key default gen_random_uuid(),
  datacrazy_lead_id text not null,
  rgm text,
  field_value text,
  outcome_created text,
  overwrote_manual_id uuid,
  error text,
  created_at timestamptz default now()
);

create index if not exists idx_crm_desfecho_sync_log_lead
  on crm_desfecho_sync_log(datacrazy_lead_id, created_at desc);

create index if not exists idx_crm_desfecho_sync_log_created_at
  on crm_desfecho_sync_log(created_at desc);
