-- Metas diárias de atendimento por consultor (vigência mensal no campo ano_mes).

create table if not exists consultor_metas (
  id              uuid primary key default gen_random_uuid(),
  consultor_nome  text not null,
  ano_mes         char(7) not null check (ano_mes ~ '^\d{4}-\d{2}$'),
  meta_marcados   integer not null check (meta_marcados >= 0),
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);

create unique index if not exists consultor_metas_nome_mes_uidx
  on consultor_metas (consultor_nome, ano_mes);

create index if not exists consultor_metas_ano_mes_idx
  on consultor_metas (ano_mes);
