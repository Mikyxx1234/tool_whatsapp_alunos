-- Histórico diário de rematrícula (SIAA / Portal) para painel de evolução.

create table if not exists rematricula_daily_stats (
  id                    uuid primary key default gen_random_uuid(),
  stat_date             date not null,
  snapshot_id           uuid references rematricula_snapshots(id) on delete set null,
  source                text,
  total_em_curso        int not null default 0,
  adimplente            int not null default 0,
  inadimplente          int not null default 0,
  pct_inadimplente      numeric(6, 2),
  delta_total           int,
  delta_adimplente      int,
  delta_inadimplente    int,
  novos_inadimplentes   int,
  recuperados_financeiro int,
  sairam_da_base        int,
  ativacoes_dia         int not null default 0,
  capture_reason        text not null default 'scheduled',
  captured_at           timestamptz not null default now(),
  unique (stat_date)
);

create index if not exists idx_rematricula_daily_stats_date
  on rematricula_daily_stats (stat_date desc);
