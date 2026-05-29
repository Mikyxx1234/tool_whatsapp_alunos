create table if not exists activation_manual_outcomes (
  id              uuid primary key default gen_random_uuid(),
  category        text not null check (category in (
    'docs-pendentes', 'financeiro', 'acessos-blackboard',
    'processos-caa', 'provavel-evasao'
  )),
  master_key      text,
  rgm             text,
  cpf             text,
  nome            text,
  protocolo       text,
  outcome         text not null check (outcome in (
    'revertido', 'confirmado', 'sem_contato', 'outro'
  )),
  motivo          text,
  notes           text,
  proof_path      text,
  proof_mime      text,
  proof_size_bytes integer,
  consultor_nome  text not null,
  occurred_at     timestamptz not null default now(),
  created_at      timestamptz not null default now()
);

create index if not exists activation_manual_outcomes_cat_rgm_idx
  on activation_manual_outcomes (category, rgm) where rgm is not null;

create index if not exists activation_manual_outcomes_cat_occurred_idx
  on activation_manual_outcomes (category, occurred_at desc);

create index if not exists activation_manual_outcomes_protocolo_idx
  on activation_manual_outcomes (protocolo) where protocolo is not null;
