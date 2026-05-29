-- Log local de atualizações do campo origem_ativacao no DataCrazy (PUT CRM).
-- Complementa activation_dispatch_events (envio do template).

create table if not exists activation_origem_ativacao_log (
  id                  uuid primary key default gen_random_uuid(),

  category            text not null,
  origem_value        text not null,
  datacrazy_lead_id   text not null,
  master_key          text,
  cpf                 text,
  rgm                 text,
  nome                text,

  status              text not null
    check (status in ('ok', 'failed', 'skipped')),
  error_message       text,

  created_at          timestamptz not null default now(),

  constraint activation_origem_log_category_check check (
    category in (
      'docs-pendentes',
      'financeiro',
      'acessos-blackboard',
      'processos-caa',
      'provavel-evasao'
    )
  )
);

create index if not exists activation_origem_log_lead_idx
  on activation_origem_ativacao_log (datacrazy_lead_id, created_at desc);

create index if not exists activation_origem_log_cat_created_idx
  on activation_origem_ativacao_log (category, created_at desc);

create index if not exists activation_origem_log_master_key_idx
  on activation_origem_ativacao_log (master_key)
  where master_key is not null;
