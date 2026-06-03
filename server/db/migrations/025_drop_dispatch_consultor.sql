-- 025_drop_dispatch_consultor.sql
-- Reverte a migration 024.
--
-- Motivo: o "consultor" não é quem clica em "Ativar" (esse é um operador / disparador,
-- pessoa diferente do consultor). O consultor de verdade é quem ASSUME a conversa no
-- DataCrazy após o aluno responder, vindo via webhook de resposta.
--
-- A próxima migration (026) introduz o modelo correto: snapshot textual em
-- activation_responses + caa_protocols, populado pelo webhook do n8n / pela
-- sincronização de desfecho CAA com o campo customizado do DataCrazy.

drop index if exists idx_activation_dispatch_events_consultor_cat_date;

alter table activation_dispatch_events
  drop column if exists consultor_id,
  drop column if exists consultor_nome;
