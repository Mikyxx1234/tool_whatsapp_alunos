-- =============================================================================
-- Migration 016 — nivel + ciclo em academic_terms
-- =============================================================================
-- Permite filtrar turmas por nível (graduação/pós) e por ciclo institucional
-- (ex.: "2026/1"). Usado pela UI de Regras e pela priorização da fila BB.
-- =============================================================================

alter table academic_terms
  add column if not exists nivel text,
  add column if not exists ciclo text;

create index if not exists idx_academic_terms_nivel on academic_terms(nivel) where nivel is not null;
create index if not exists idx_academic_terms_ciclo on academic_terms(ciclo) where ciclo is not null;
