-- =============================================================================
-- Migration 006 — Calendário Acadêmico (turmas/ciclos) + dados Blackboard
-- =============================================================================
-- Cria a tabela `academic_terms` (turma/período) que centraliza datas e regras
-- por ciclo. Os alunos passam a se vincular a uma term e herdam datas e
-- configurações; podem sobrescrever individualmente via campos `override_*`.
--
-- Também adiciona campos de telemetria do Blackboard (rgm, ultimo acesso,
-- minutos, total de interações) no aluno.
-- =============================================================================

create table if not exists academic_terms (
  id                       uuid primary key default gen_random_uuid(),
  -- código curto do ciclo (ex: "2026/1", "2026.2-EAD")
  codigo                   text not null,
  nome                     text not null,
  descricao                text,

  -- janela de matrícula
  inicio_matricula         date,
  fim_matricula            date,

  -- janela do conteúdo (datas usadas pelo decisionEngine para o GAP)
  inicio_conteudo          date,
  fim_conteudo             date,

  -- ambientação (período antes/início para onboarding)
  tem_ambientacao          boolean not null default false,
  dias_ambientacao         int     not null default 0,

  -- conteúdo prévio (já está liberado antes de inicio_conteudo?)
  conteudo_previo_liberado boolean not null default false,

  -- atraso permitido no início real (ex: turma pode atrasar 5 dias)
  permitir_atraso          boolean not null default false,
  dias_atraso_max          int     not null default 0,

  -- como o aluno entra no conteúdo
  --   imediato      -> acessa logo após matrícula
  --   data_fixa     -> usa inicio_conteudo
  --   proximo_mes   -> primeiro dia do mês seguinte à matrícula
  --   manual        -> requer liberação manual (campo override no aluno)
  tipo_inicio              text not null default 'data_fixa'
    check (tipo_inicio in ('imediato','data_fixa','proximo_mes','manual')),

  -- liberação de acesso à plataforma
  --   imediato | D+1 | D+2 | custom
  liberacao_acesso         text not null default 'imediato'
    check (liberacao_acesso in ('imediato','D+1','D+2','custom')),
  liberacao_acesso_dias    int  not null default 0,  -- usado quando = 'custom'

  -- metadados estendidos (campos extras vêm como JSON)
  metadata                 jsonb,

  ativo                    boolean not null default true,
  created_at               timestamptz not null default now(),
  updated_at               timestamptz not null default now()
);

create unique index if not exists uq_academic_terms_codigo on academic_terms(codigo);
create index        if not exists idx_academic_terms_ativo  on academic_terms(ativo);
create index        if not exists idx_academic_terms_dates  on academic_terms(inicio_conteudo);

drop trigger if exists trg_academic_terms_updated_at on academic_terms;
create trigger trg_academic_terms_updated_at
  before update on academic_terms
  for each row execute function set_updated_at();

-- -----------------------------------------------------------------------------
-- ALTERs em students: vínculo com a turma + overrides + telemetria Blackboard
-- -----------------------------------------------------------------------------
alter table students
  add column if not exists term_id                          uuid references academic_terms(id) on delete set null,
  add column if not exists rgm                              text,
  add column if not exists ciclo                            text,
  add column if not exists tipo_matricula                   text,
  add column if not exists instituicao                      text,
  add column if not exists empresa                          text,

  -- overrides individuais (sobrescrevem term/legado quando preenchidos)
  add column if not exists override_data_inicio_conteudo    date,
  add column if not exists override_data_acesso_liberado    date,

  -- telemetria do Blackboard (sobrescritos a cada importação)
  add column if not exists ultimo_acesso_blackboard         timestamptz,
  add column if not exists minutos_acesso                   int,
  add column if not exists total_interacoes                 int,
  add column if not exists total_registros                  int,
  add column if not exists fonte_dados                      text;

create index if not exists idx_students_term  on students(term_id);
create index if not exists idx_students_rgm   on students(rgm) where rgm is not null;
create index if not exists idx_students_ciclo on students(ciclo);

create unique index if not exists uq_students_rgm
  on students(rgm)
  where rgm is not null and rgm <> '';
