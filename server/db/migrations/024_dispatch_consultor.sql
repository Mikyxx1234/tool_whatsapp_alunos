-- 024_dispatch_consultor.sql
-- Adiciona identidade do consultor que disparou cada ativação.
--
-- Os campos são opcionais (nullable) para retrocompatibilidade — dispatches antigos
-- e disparos automáticos (scheduler) continuam funcionando com consultor=null.
--
-- consultor_id é INT (compatível com app_users.id do projeto dcz-crm-sync, que é serial).
-- NÃO se cria FK física porque os 2 sistemas podem viver em schemas/bancos separados;
-- a integridade fica como FK lógica gerenciada pela aplicação.
--
-- consultor_nome é snapshot: preserva o nome no momento do disparo, mesmo que o
-- usuário seja renomeado/deletado depois (histórico íntegro).

alter table activation_dispatch_events
  add column if not exists consultor_id integer,
  add column if not exists consultor_nome text;

create index if not exists idx_activation_dispatch_events_consultor_cat_date
  on activation_dispatch_events (consultor_id, category, created_at desc)
  where consultor_id is not null;
