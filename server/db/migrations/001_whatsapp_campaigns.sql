-- =============================================================================
-- Migration 001 — Estrutura completa de campanhas de WhatsApp
-- Aplicar via: npm run migrate
-- =============================================================================

create extension if not exists "pgcrypto";

-- -----------------------------------------------------------------------------
-- 1. campaign_types
-- -----------------------------------------------------------------------------
create table if not exists campaign_types (
  id          uuid primary key default gen_random_uuid(),
  code        text not null unique,
  name        text not null,
  description text,
  is_active   boolean not null default true,
  created_at  timestamptz not null default now()
);

insert into campaign_types (code, name, description) values
  ('FINANCEIRO',         'Financeiro',
    'Inadimplência, vencimento de mensalidade, lembrete de pagamento, rematrícula.'),
  ('ACESSO_PLATAFORMA',  'Acesso à plataforma',
    'Alunos sem acesso há muitos dias, inativos na plataforma, alerta de engajamento.'),
  ('PROVAS_AVALIACOES',  'Provas e avaliações',
    'Aviso de prova, prazo de avaliação, lembrete de documentação acadêmica.')
on conflict (code) do nothing;

-- -----------------------------------------------------------------------------
-- 2. whatsapp_campaigns
-- -----------------------------------------------------------------------------
create table if not exists whatsapp_campaigns (
  id                   uuid primary key default gen_random_uuid(),
  campaign_type_id     uuid references campaign_types(id) on delete restrict,
  name                 text not null,
  description          text,
  template_name        text,
  template_language    text default 'pt_BR',
  template_category    text,
  source_file_name     text,
  total_contacts       int not null default 0,
  total_valid          int not null default 0,
  total_invalid        int not null default 0,
  total_duplicates     int not null default 0,
  total_sent           int not null default 0,
  total_failed         int not null default 0,
  total_interacted     int not null default 0,
  total_not_interacted int not null default 0,
  status               text not null default 'draft'
    check (status in (
      'draft','validating','ready','sending','paused',
      'cancelled','completed','completed_with_errors','failed'
    )),
  interval_seconds     int not null default 5,
  daily_limit          int,
  started_at           timestamptz,
  finished_at          timestamptz,
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now(),
  created_by           text
);

create index if not exists idx_campaigns_type       on whatsapp_campaigns(campaign_type_id);
create index if not exists idx_campaigns_status     on whatsapp_campaigns(status);
create index if not exists idx_campaigns_created_at on whatsapp_campaigns(created_at desc);

-- -----------------------------------------------------------------------------
-- 3. whatsapp_campaign_contacts
-- -----------------------------------------------------------------------------
create table if not exists whatsapp_campaign_contacts (
  id                    uuid primary key default gen_random_uuid(),
  campaign_id           uuid not null references whatsapp_campaigns(id) on delete cascade,
  phone                 text not null,
  normalized_phone      text not null,
  name                  text,
  email                 text,
  student_id            text,
  cpf                   text,
  course                text,
  origem                text,
  raw_data              jsonb,
  validation_status     text not null default 'pending'
    check (validation_status in ('pending','valid','invalid','duplicate')),
  send_status           text not null default 'pending'
    check (send_status in ('pending','queued','sending','sent','failed','skipped','cancelled')),
  interaction_status    text not null default 'unknown'
    check (interaction_status in ('unknown','interacted','not_interacted')),
  duplicate_key         text,
  error_message         text,
  sent_at               timestamptz,
  delivered_at          timestamptz,
  read_at               timestamptz,
  first_interaction_at  timestamptz,
  last_interaction_at   timestamptz,
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now()
);

create index if not exists idx_contacts_campaign         on whatsapp_campaign_contacts(campaign_id);
create index if not exists idx_contacts_phone            on whatsapp_campaign_contacts(normalized_phone);
create index if not exists idx_contacts_send_status      on whatsapp_campaign_contacts(send_status);
create index if not exists idx_contacts_interaction      on whatsapp_campaign_contacts(interaction_status);
create index if not exists idx_contacts_validation       on whatsapp_campaign_contacts(validation_status);
create index if not exists idx_contacts_campaign_status  on whatsapp_campaign_contacts(campaign_id, send_status);

-- garante 1 contato por (campanha, telefone normalizado) — útil pro retry seguro
create unique index if not exists uq_contacts_campaign_phone
  on whatsapp_campaign_contacts(campaign_id, normalized_phone);

-- -----------------------------------------------------------------------------
-- 4. whatsapp_message_logs
-- -----------------------------------------------------------------------------
create table if not exists whatsapp_message_logs (
  id                   uuid primary key default gen_random_uuid(),
  campaign_id          uuid references whatsapp_campaigns(id) on delete cascade,
  campaign_contact_id  uuid references whatsapp_campaign_contacts(id) on delete cascade,
  direction            text not null check (direction in ('outbound','inbound')),
  provider             text not null default 'datacrazy',
  provider_message_id  text,
  normalized_phone     text,
  template_name        text,
  payload              jsonb,
  response             jsonb,
  status               text,
  error_message        text,
  sent_at              timestamptz,
  received_at          timestamptz,
  created_at           timestamptz not null default now()
);

create index if not exists idx_logs_campaign     on whatsapp_message_logs(campaign_id);
create index if not exists idx_logs_contact      on whatsapp_message_logs(campaign_contact_id);
create index if not exists idx_logs_phone        on whatsapp_message_logs(normalized_phone);
create index if not exists idx_logs_provider_msg on whatsapp_message_logs(provider_message_id);
create index if not exists idx_logs_direction    on whatsapp_message_logs(direction, created_at desc);

-- -----------------------------------------------------------------------------
-- 5. whatsapp_interactions
-- -----------------------------------------------------------------------------
create table if not exists whatsapp_interactions (
  id                   uuid primary key default gen_random_uuid(),
  campaign_id          uuid references whatsapp_campaigns(id) on delete cascade,
  campaign_contact_id  uuid references whatsapp_campaign_contacts(id) on delete cascade,
  normalized_phone     text not null,
  message_text         text,
  message_type         text,
  provider_message_id  text,
  interacted_at        timestamptz not null default now(),
  raw_payload          jsonb,
  created_at           timestamptz not null default now()
);

create index if not exists idx_interactions_campaign on whatsapp_interactions(campaign_id);
create index if not exists idx_interactions_phone    on whatsapp_interactions(normalized_phone);
create index if not exists idx_interactions_at       on whatsapp_interactions(interacted_at desc);

-- -----------------------------------------------------------------------------
-- 6. whatsapp_campaign_events (auditoria)
-- -----------------------------------------------------------------------------
create table if not exists whatsapp_campaign_events (
  id            uuid primary key default gen_random_uuid(),
  campaign_id   uuid references whatsapp_campaigns(id) on delete cascade,
  event_type    text not null,
  event_message text,
  metadata      jsonb,
  created_at    timestamptz not null default now()
);

create index if not exists idx_events_campaign
  on whatsapp_campaign_events(campaign_id, created_at desc);
create index if not exists idx_events_type
  on whatsapp_campaign_events(event_type);

-- -----------------------------------------------------------------------------
-- 7. whatsapp_inbound_unmatched (mensagens recebidas sem campanha correlata)
-- -----------------------------------------------------------------------------
create table if not exists whatsapp_inbound_unmatched (
  id                  uuid primary key default gen_random_uuid(),
  normalized_phone    text not null,
  message_text        text,
  message_type        text,
  provider_message_id text,
  raw_payload         jsonb,
  created_at          timestamptz not null default now()
);

create index if not exists idx_inbound_unmatched_phone on whatsapp_inbound_unmatched(normalized_phone);
create index if not exists idx_inbound_unmatched_at    on whatsapp_inbound_unmatched(created_at desc);

-- -----------------------------------------------------------------------------
-- Trigger genérica de updated_at
-- -----------------------------------------------------------------------------
create or replace function set_updated_at() returns trigger as $$
begin
  new.updated_at = now();
  return new;
end;
$$ language plpgsql;

drop trigger if exists trg_campaigns_updated_at on whatsapp_campaigns;
create trigger trg_campaigns_updated_at
  before update on whatsapp_campaigns
  for each row execute function set_updated_at();

drop trigger if exists trg_contacts_updated_at on whatsapp_campaign_contacts;
create trigger trg_contacts_updated_at
  before update on whatsapp_campaign_contacts
  for each row execute function set_updated_at();

-- -----------------------------------------------------------------------------
-- Views para dashboard
-- -----------------------------------------------------------------------------
create or replace view vw_whatsapp_campaign_summary as
select
  c.id,
  c.name,
  ct.code               as campaign_type,
  ct.name               as campaign_type_name,
  c.template_name,
  c.template_language,
  c.template_category,
  c.status,
  c.total_contacts,
  c.total_valid,
  c.total_invalid,
  c.total_duplicates,
  c.total_sent,
  c.total_failed,
  c.total_interacted,
  c.total_not_interacted,
  case
    when c.total_valid > 0 then round(100.0 * c.total_sent / c.total_valid, 2)
    else 0
  end as taxa_envio,
  case
    when c.total_sent > 0 then round(100.0 * c.total_interacted / c.total_sent, 2)
    else 0
  end as taxa_interacao,
  c.created_at,
  c.started_at,
  c.finished_at
from whatsapp_campaigns c
left join campaign_types ct on ct.id = c.campaign_type_id;

create or replace view vw_whatsapp_campaign_contacts_status as
select
  cc.id                 as contact_id,
  cc.campaign_id,
  c.name                as campaign_name,
  ct.code               as campaign_type,
  cc.normalized_phone,
  cc.name,
  cc.email,
  cc.course,
  cc.send_status,
  cc.validation_status,
  cc.interaction_status,
  cc.sent_at,
  cc.delivered_at,
  cc.read_at,
  cc.first_interaction_at,
  cc.last_interaction_at,
  cc.error_message
from whatsapp_campaign_contacts cc
join whatsapp_campaigns c on c.id = cc.campaign_id
left join campaign_types ct on ct.id = c.campaign_type_id;

create or replace view vw_whatsapp_campaign_type_performance as
select
  ct.code                                as campaign_type,
  ct.name                                as campaign_type_name,
  count(c.id)                            as total_campaigns,
  coalesce(sum(c.total_contacts), 0)     as total_contacts,
  coalesce(sum(c.total_sent), 0)         as total_sent,
  coalesce(sum(c.total_failed), 0)       as total_failed,
  coalesce(sum(c.total_interacted), 0)   as total_interacted,
  coalesce(sum(c.total_not_interacted),0) as total_not_interacted,
  case
    when coalesce(sum(c.total_sent), 0) > 0
      then round(100.0 * coalesce(sum(c.total_interacted), 0) / sum(c.total_sent), 2)
    else 0
  end as taxa_interacao_media
from campaign_types ct
left join whatsapp_campaigns c on c.campaign_type_id = ct.id
group by ct.code, ct.name
order by ct.name;
