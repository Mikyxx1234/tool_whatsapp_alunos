-- =============================================================================
-- Migration 007 — Regras de Jornada configuráveis (singleton + por turma)
-- =============================================================================
-- Tabela `journey_settings` armazena thresholds e flags que antes estavam
-- hardcoded no decisionEngine. O escopo é hierárquico:
--   - linha com term_id = NULL  -> default global (singleton 'GLOBAL')
--   - linha com term_id = X     -> override por turma
-- O resolver no backend pega o override por turma se existir, senão o GLOBAL.
-- =============================================================================

create table if not exists journey_settings (
  id                      uuid primary key default gen_random_uuid(),
  term_id                 uuid references academic_terms(id) on delete cascade,
  scope                   text not null default 'GLOBAL'
    check (scope in ('GLOBAL','TERM')),

  -- thresholds GAP (em dias)
  gap_threshold_a         int  not null default 2,
  gap_threshold_b         int  not null default 30,

  -- regra: ambientação ativa? (espelha a flag da turma p/ permitir override)
  ambientacao_ativa       boolean not null default false,
  ambientacao_obrigatoria boolean not null default false,
  ambientacao_dias        int     not null default 0,

  -- regra: conteúdo prévio liberado?
  conteudo_previo_ativo   boolean not null default false,

  -- regra: atraso na data de início?
  delay_inicio_ativo      boolean not null default false,
  delay_inicio_max_dias   int     not null default 0,
  delay_inicio_acao       text    not null default 'avisar'
    check (delay_inicio_acao in ('avisar','ajustar','ambos')),

  -- regra: liberação de acesso (espelho da turma)
  liberacao_acesso        text    not null default 'imediato'
    check (liberacao_acesso in ('imediato','D+1','D+2','custom')),
  liberacao_acesso_dias   int     not null default 0,

  -- regra: aluno inativo após X dias sem acesso aciona recuperação
  inativo_dias            int     not null default 7,

  -- bag genérica para regras futuras sem migration
  raw_config              jsonb,

  created_at              timestamptz not null default now(),
  updated_at              timestamptz not null default now()
);

create unique index if not exists uq_journey_settings_global
  on journey_settings(scope) where scope = 'GLOBAL';
create unique index if not exists uq_journey_settings_term
  on journey_settings(term_id) where term_id is not null;

drop trigger if exists trg_journey_settings_updated_at on journey_settings;
create trigger trg_journey_settings_updated_at
  before update on journey_settings
  for each row execute function set_updated_at();

-- Seed inicial GLOBAL com os defaults antigos (mantém compatibilidade).
insert into journey_settings (scope, gap_threshold_a, gap_threshold_b)
select 'GLOBAL', 2, 30
where not exists (select 1 from journey_settings where scope = 'GLOBAL');
