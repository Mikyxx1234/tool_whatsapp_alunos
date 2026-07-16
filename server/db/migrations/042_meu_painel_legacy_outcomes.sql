-- Snapshot read-only do Meu Painel DataCrazy (responses + marcações manuais)
-- para exibir no painel Novo CRM após cutover (badge "Histórico").

create table if not exists meu_painel_legacy_outcomes (
  id              uuid primary key default gen_random_uuid(),
  source          text not null default 'datacrazy',
  category        text not null,
  response_id     text,
  master_key      text,
  rgm             text,
  cpf             text,
  nome            text,
  telefone        text,
  consultor_nome  text,
  origem_ativacao text,
  response_kind   text,
  received_at     timestamptz,
  outcome         text,
  outcome_motivo  text,
  outcome_notes   text,
  outcome_occurred_at timestamptz,
  raw             jsonb not null default '{}'::jsonb,
  migrated_at     timestamptz not null default now(),
  constraint meu_painel_legacy_outcomes_outcome_check check (
    outcome is null
    or outcome in ('revertido', 'confirmado', 'sem_contato', 'outro')
  )
);

create unique index if not exists meu_painel_legacy_outcomes_response_uidx
  on meu_painel_legacy_outcomes (response_id)
  where response_id is not null;

create index if not exists meu_painel_legacy_outcomes_period_idx
  on meu_painel_legacy_outcomes (coalesce(outcome_occurred_at, received_at) desc nulls last);

create index if not exists meu_painel_legacy_outcomes_category_idx
  on meu_painel_legacy_outcomes (category);

create index if not exists meu_painel_legacy_outcomes_consultor_idx
  on meu_painel_legacy_outcomes (consultor_nome);
