-- Migration 022 — config da janela "stale" pra limpeza de origem_ativacao.
--
-- Após este tempo desde o último PUT de SET no CRM:
--   1. O job de cleanup (POST /api/maintenance/clean-stale-origem-ativacao + cron 24h)
--      limpa o campo origem_ativacao no CRM (PUT value="").
--   2. Respostas em activation_responses cujo dispatch correspondente seja
--      mais antigo que este intervalo são ignoradas em queries de leitura
--      (taxa de resposta, ResponseBadge no roster, etc.) — auditoria preservada,
--      só não contam nas métricas.
--
-- Default 72h (3 dias) cobre janela CAA (48h) + folga, e categorias não-CAA
-- têm sobra confortável. Range: 1h a 1 ano.

alter table journey_settings
  add column if not exists origem_ativacao_stale_hours integer default 72
    check (origem_ativacao_stale_hours >= 1 and origem_ativacao_stale_hours <= 8760);
