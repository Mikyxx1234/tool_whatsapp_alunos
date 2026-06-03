-- 026_consultor_responsavel.sql
-- Snapshot textual do consultor responsável pelo lead no DataCrazy.
--
-- FONTE: o consultor que ASSUME o lead no inbox do DataCrazy após a resposta.
-- O DataCrazy guarda essa info num campo customizado; o n8n envia esse valor
-- junto da resposta no webhook (/api/activation/responses) e também é lido
-- durante o sync de desfecho CAA (crmDesfechoSyncService).
--
-- ARMAZENAMENTO: texto puro (snapshot) — não FK para `dcz.app_users`.
-- O snapshot preserva histórico mesmo se o user for renomeado/deletado lá.
-- Depois do merge com dcz-crm-sync, o painel resolve consultor_nome → app_user
-- por similarity sobre `username` ou `email_cruzeiro`.

alter table activation_responses
  add column if not exists consultor_responsavel_nome text;

alter table caa_protocols
  add column if not exists consultor_responsavel_nome text,
  add column if not exists consultor_responsavel_updated_at timestamptz;

create index if not exists activation_responses_consultor_idx
  on activation_responses (consultor_responsavel_nome)
  where consultor_responsavel_nome is not null;

create index if not exists caa_protocols_consultor_idx
  on caa_protocols (consultor_responsavel_nome, status)
  where consultor_responsavel_nome is not null;
