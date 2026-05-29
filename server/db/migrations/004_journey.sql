-- =============================================================================
-- Migration 004 — Régua Inteligente: templates internos, eventos e timeline
-- Adiciona o tipo de campanha RELACIONAMENTO e estende whatsapp_campaigns/
-- whatsapp_campaign_contacts para suportar o modo "journey".
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1. Tipo de campanha "RELACIONAMENTO" (boas-vindas/onboarding)
-- -----------------------------------------------------------------------------
insert into campaign_types (code, name, description) values
  ('RELACIONAMENTO', 'Relacionamento',
    'Boas-vindas, onboarding e comunicação institucional automatizada.')
on conflict (code) do nothing;

-- -----------------------------------------------------------------------------
-- 2. campaign_templates — recipe interno da régua
--    NÃO substitui templates oficiais Meta; aponta para eles via nome_template.
-- -----------------------------------------------------------------------------
create table if not exists campaign_templates (
  id                  uuid primary key default gen_random_uuid(),
  campaign_type_id    uuid references campaign_types(id) on delete set null,
  canal               text not null check (canal in ('whatsapp','email')),
  fluxo               text check (fluxo is null or fluxo in ('A','B','C')),
  evento              text not null check (evento in ('D0','D+1','D+3','D-7','D-1','LOOP','RECUPERACAO')),
  delay_dias          int not null default 0,
  nome_template       text,
  template_language   text default 'pt_BR',
  conteudo            text,
  variaveis           jsonb,
  ativo               boolean not null default true,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now()
);

create index if not exists idx_campaign_templates_lookup
  on campaign_templates(canal, fluxo, evento)
  where ativo = true;

drop trigger if exists trg_campaign_templates_updated_at on campaign_templates;
create trigger trg_campaign_templates_updated_at
  before update on campaign_templates
  for each row execute function set_updated_at();

-- -----------------------------------------------------------------------------
-- 3. scheduled_events — fila persistida da régua
-- -----------------------------------------------------------------------------
create table if not exists scheduled_events (
  id              uuid primary key default gen_random_uuid(),
  student_id      uuid not null references students(id) on delete cascade,
  campaign_id     uuid references whatsapp_campaigns(id) on delete set null,
  template_id     uuid references campaign_templates(id) on delete set null,
  canal           text not null check (canal in ('whatsapp','email')),
  event_type      text,
  execution_date  timestamptz not null,
  status          text not null default 'pending'
    check (status in ('pending','processing','sent','failed','cancelled','skipped')),
  attempts        int not null default 0,
  max_attempts    int not null default 3,
  last_error      text,
  locked_at       timestamptz,
  processed_at    timestamptz,
  metadata        jsonb,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);

create index if not exists idx_events_execution_date on scheduled_events(execution_date);
create index if not exists idx_events_status         on scheduled_events(status);
create index if not exists idx_events_student        on scheduled_events(student_id);
create index if not exists idx_events_campaign       on scheduled_events(campaign_id);
create index if not exists idx_events_template       on scheduled_events(template_id);
-- Índice composto otimizado para o claim do scheduler.
create index if not exists idx_events_pending_due
  on scheduled_events(status, execution_date)
  where status = 'pending';

drop trigger if exists trg_scheduled_events_updated_at on scheduled_events;
create trigger trg_scheduled_events_updated_at
  before update on scheduled_events
  for each row execute function set_updated_at();

-- -----------------------------------------------------------------------------
-- 4. student_timeline_events — timeline consolidada do aluno
-- -----------------------------------------------------------------------------
create table if not exists student_timeline_events (
  id           uuid primary key default gen_random_uuid(),
  student_id   uuid not null references students(id) on delete cascade,
  event_type   text not null,
  title        text,
  description  text,
  metadata     jsonb,
  created_at   timestamptz not null default now()
);

create index if not exists idx_timeline_student
  on student_timeline_events(student_id, created_at desc);
create index if not exists idx_timeline_type
  on student_timeline_events(event_type);

-- -----------------------------------------------------------------------------
-- 5. Ajustes em whatsapp_campaigns para distinguir manual vs journey
-- -----------------------------------------------------------------------------
alter table whatsapp_campaigns
  add column if not exists mode         text not null default 'manual',
  add column if not exists source       text not null default 'csv',
  add column if not exists is_automated boolean not null default false;

-- Soft-check via DO block (constraint pode já existir após reaplicar)
do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'whatsapp_campaigns_mode_check'
  ) then
    alter table whatsapp_campaigns
      add constraint whatsapp_campaigns_mode_check
      check (mode in ('manual','journey'));
  end if;

  if not exists (
    select 1 from pg_constraint where conname = 'whatsapp_campaigns_source_check'
  ) then
    alter table whatsapp_campaigns
      add constraint whatsapp_campaigns_source_check
      check (source in ('csv','manual','api','scheduler'));
  end if;
end$$;

create index if not exists idx_campaigns_mode on whatsapp_campaigns(mode);

-- -----------------------------------------------------------------------------
-- 6. Ajustes em whatsapp_campaign_contacts: vincular ao aluno e ao evento
-- -----------------------------------------------------------------------------
alter table whatsapp_campaign_contacts
  add column if not exists student_id         uuid references students(id) on delete set null,
  add column if not exists scheduled_event_id uuid references scheduled_events(id) on delete set null;

create index if not exists idx_contacts_student
  on whatsapp_campaign_contacts(student_id);
create index if not exists idx_contacts_scheduled_event
  on whatsapp_campaign_contacts(scheduled_event_id);

-- -----------------------------------------------------------------------------
-- 7. Seed mínimo de campaign_templates (recipe da régua).
--    nome_template aponta para templates Meta a serem confirmados pelo cliente.
--    TODO [CURSOR]: substituir os nomes pelos templates aprovados reais.
-- -----------------------------------------------------------------------------
insert into campaign_templates
  (campaign_type_id, canal, fluxo, evento, delay_dias, nome_template, conteudo, ativo)
select
  ct.id, t.canal, t.fluxo, t.evento, t.delay_dias, t.nome_template, t.conteudo, true
from (
  values
    -- Fluxo A — ativação imediata
    ('whatsapp','A','D0',     0, 'boas_vindas_ativacao',   'Boas-vindas e ativação imediata'),
    ('whatsapp','A','D+1',    1, 'lembrete_acesso_d1',     'Lembrete de primeiro acesso'),
    ('whatsapp','A','RECUPERACAO', 3, 'recuperacao_d3',    'Recuperação se não acessou'),

    -- Fluxo B — espera curta
    ('whatsapp','B','D0',     0, 'boas_vindas_b',          'Boas-vindas (fluxo B)'),
    ('whatsapp','B','D+3',    3, 'aquecimento_b',          'Aquecimento — conteúdo prévio'),
    ('whatsapp','B','D-7',   -7, 'preparacao_inicio',      'Preparação para início (D-7)'),
    ('whatsapp','B','D-1',   -1, 'lembrete_final',         'Lembrete final véspera'),

    -- Fluxo C — espera longa
    ('whatsapp','C','D0',     0, 'boas_vindas_c',          'Boas-vindas (fluxo C)'),
    ('whatsapp','C','LOOP',   7, 'engajamento_loop',       'Engajamento semanal (loop)'),
    ('whatsapp','C','D-7',   -7, 'preparacao_inicio',      'Preparação para início (D-7)'),
    ('whatsapp','C','D-1',   -1, 'lembrete_final',         'Lembrete final véspera')
) as t(canal, fluxo, evento, delay_dias, nome_template, conteudo)
left join campaign_types ct on ct.code = 'RELACIONAMENTO'
where not exists (
  select 1 from campaign_templates x
  where x.canal = t.canal and x.fluxo = t.fluxo and x.evento = t.evento
);
