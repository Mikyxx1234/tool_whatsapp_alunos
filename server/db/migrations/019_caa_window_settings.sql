alter table journey_settings
  add column if not exists caa_janela_t0 text default 'data_chegada'
    check (caa_janela_t0 in ('data_chegada','primeiro_export','primeiro_envio')),
  add column if not exists caa_janela_dias_tipo text default 'corridos'
    check (caa_janela_dias_tipo in ('corridos','uteis'));
