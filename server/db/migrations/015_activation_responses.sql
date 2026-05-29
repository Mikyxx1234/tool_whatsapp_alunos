-- Migration 015 — Respostas de ativação (lidas; gravação externa via DataCrazy/webhook)
--
-- A app NÃO recebe webhook diretamente. A gravação dessa tabela é feita
-- externamente (DataCrazy → integração) e a app apenas LÊ daqui para:
--   1. Marcar "Interagiu" no roster da fila de ativação.
--   2. Cruzar com transições CAA para identificar
--      "respondeu mas perdemos" / "respondeu e revertemos".
--
-- Como correlacionar com a fila:
--   - PRIMEIRA escolha:  master_key (mesma chave gerada por masterKeyFromActivationItem)
--   - SEGUNDA escolha:   datacrazy_lead_id (bate com activation_dispatch_events.datacrazy_lead_id)
--   - TERCEIRA escolha:  telefone normalizado (último envio dentro de N horas)
--
-- O preenchedor pode informar qualquer combinação; a app resolve no SELECT.

create table if not exists activation_responses (
  id                  uuid primary key default gen_random_uuid(),

  -- Correlação (qualquer um pode estar preenchido; pelo menos um é necessário)
  category            text,
  master_key          text,
  datacrazy_lead_id   text,
  telefone            text,
  rgm                 text,

  -- Conteúdo da resposta
  response_kind       text not null default 'click'
    check (response_kind in ('click', 'message', 'opt_out', 'other')),
  button_payload      text,
  message_text        text,

  -- Idempotência (id do evento no provedor)
  external_id         text,

  raw_payload         jsonb,
  received_at         timestamptz not null default now(),
  created_at          timestamptz not null default now()
);

create unique index if not exists activation_responses_external_id_uidx
  on activation_responses (external_id)
  where external_id is not null;

create index if not exists activation_responses_cat_master_idx
  on activation_responses (category, master_key)
  where master_key is not null;

create index if not exists activation_responses_lead_idx
  on activation_responses (datacrazy_lead_id)
  where datacrazy_lead_id is not null;

create index if not exists activation_responses_phone_idx
  on activation_responses (telefone)
  where telefone is not null;

create index if not exists activation_responses_received_idx
  on activation_responses (received_at desc);
