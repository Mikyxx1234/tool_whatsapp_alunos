alter table journey_settings
  add column if not exists bb_nao_acessa_dias integer default 14
    check (bb_nao_acessa_dias >= 1 and bb_nao_acessa_dias <= 365),
  add column if not exists bb_acessou_pouco_minutos integer default 60
    check (bb_acessou_pouco_minutos >= 0),
  add column if not exists bb_acessou_pouco_interacoes integer default 10
    check (bb_acessou_pouco_interacoes >= 0);
