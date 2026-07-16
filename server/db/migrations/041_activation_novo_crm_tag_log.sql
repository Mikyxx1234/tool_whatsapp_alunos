-- Log local de tags de ativação aplicadas no CRM EduIT (Novo CRM).
-- Espelha activation_origem_ativacao_log: SET (tag_value=nome) → CLEAR (tag_value='').
-- Janela stale reutiliza journey_settings.origem_ativacao_stale_hours.

create table if not exists activation_novo_crm_tag_log (
  id              uuid primary key default gen_random_uuid(),

  category        text not null,
  tag_name        text not null,
  tag_id          text,
  -- SET: nome da tag; CLEAR: '' (mesmo padrão de origem_value)
  tag_value       text not null,

  contact_id      text not null,
  deal_id         text,
  master_key      text,
  cpf             text,
  rgm             text,
  nome            text,

  status          text not null
    check (status in ('ok', 'failed', 'skipped')),
  error_message   text,

  created_at      timestamptz not null default now(),

  constraint activation_novo_crm_tag_log_category_check check (
    category in (
      'docs-pendentes',
      'financeiro',
      'acessos-blackboard',
      'processos-caa',
      'provavel-evasao',
      'aguardando-inicio',
      'conteudo-previo',
      'rematricula'
    )
  )
);

create index if not exists activation_novo_crm_tag_log_contact_idx
  on activation_novo_crm_tag_log (contact_id, created_at desc);

create index if not exists activation_novo_crm_tag_log_tag_name_idx
  on activation_novo_crm_tag_log (tag_name, created_at desc);

create index if not exists activation_novo_crm_tag_log_deal_idx
  on activation_novo_crm_tag_log (deal_id, created_at desc)
  where deal_id is not null;
