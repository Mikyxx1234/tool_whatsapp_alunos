-- =============================================================================
-- Migration 003 — Base de alunos (Régua Inteligente)
-- Cria a tabela `students` que será a entidade central da régua de relacionamento.
-- =============================================================================

create table if not exists students (
  id                    uuid primary key default gen_random_uuid(),
  nome                  text not null,
  telefone              text,
  telefone_normalizado  text,
  email                 text,
  cpf                   text,
  curso                 text,
  polo                  text,
  origem                text,
  data_matricula        date,
  data_inicio_conteudo  date,
  data_acesso_liberado  date,
  ultimo_acesso         timestamptz,
  gap_dias              int,
  fluxo                 text
    check (fluxo is null or fluxo in ('A','B','C')),
  status                text not null default 'ativo'
    check (status in ('ativo','iniciado','inativo','cancelado')),
  engagement_score      numeric not null default 0,
  raw_data              jsonb,
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now()
);

-- Índices para busca/filtro/dashboard
create index if not exists idx_students_phone     on students(telefone_normalizado);
create index if not exists idx_students_cpf       on students(cpf);
create index if not exists idx_students_email     on students(email);
create index if not exists idx_students_fluxo     on students(fluxo);
create index if not exists idx_students_status    on students(status);
create index if not exists idx_students_matricula on students(data_matricula);
create index if not exists idx_students_inicio    on students(data_inicio_conteudo);

-- Idempotência no import: cpf é a chave forte; telefone fica como fallback.
-- Índices únicos parciais para tolerar registros sem cpf ou sem telefone.
create unique index if not exists uq_students_cpf
  on students(cpf)
  where cpf is not null and cpf <> '';

create unique index if not exists uq_students_phone
  on students(telefone_normalizado)
  where telefone_normalizado is not null and telefone_normalizado <> '';

-- Reusa a função set_updated_at criada na migration 001.
drop trigger if exists trg_students_updated_at on students;
create trigger trg_students_updated_at
  before update on students
  for each row execute function set_updated_at();
