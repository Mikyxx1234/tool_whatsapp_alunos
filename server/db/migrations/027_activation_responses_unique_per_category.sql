-- Migration 027 — Permite 1 resposta por (external_id, category) em vez de só (external_id).
--
-- Problema corrigido:
--   Quando uma pessoa tinha 2+ disparos pendentes (ex: CAA + DOC) e respondia
--   uma única vez, o UNIQUE em external_id bloqueava a 2ª resposta no banco.
--   A resposta caía em apenas uma das categorias (a 1ª retornada pelo INSERT
--   do n8n), e o painel de Conversão da outra categoria mostrava 0 respostas.
--
-- Mudança:
--   Trocar UNIQUE(external_id) por UNIQUE(external_id, category). Cada resposta
--   passa a ser idempotente por (conversa × categoria), e o n8n insere 1 linha
--   por dispatch elegível (CAA insere com category='processos-caa', DOC insere
--   com category='docs-pendentes', etc).
--
-- Backfill: NÃO retroage. Respostas antigas continuam onde estão; o efeito
-- só vale pra disparos/respostas a partir do deploy desta migration + da
-- atualização do workflow n8n (NOT EXISTS precisa checar category também —
-- veja decisão em AGENTS.md do dcz-crm-sync).

drop index if exists activation_responses_external_id_uidx;

create unique index if not exists activation_responses_external_id_category_uidx
  on activation_responses (external_id, category)
  where external_id is not null;
