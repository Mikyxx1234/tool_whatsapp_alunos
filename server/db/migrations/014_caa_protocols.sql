-- Migration 014 — CAA: estado vivo por protocolo + histórico de transições
--
-- Regra de negócio:
--   Cada linha do export `data.xlsx` do CAA é um protocolo.
--   Status normalizado por (Situação Atendimento, Situação Deferimento):
--     PENDENTE  + Em aberto    → 'open'           (fila de ativação)
--     CANCELADO + qualquer     → 'lost_canceled'  (aluno desistiu antes do CAA decidir)
--     CONCLUIDO + Deferido     → 'lost_confirmed' (CAA aprovou o cancelamento)
--     CONCLUIDO + Indeferido   → 'won_reverted'   (CAA negou o cancelamento)
--     resto                    → 'unknown'

create table if not exists caa_protocols (
  protocolo                  text primary key,
  rgm                        text,
  cpf                        text,
  nome                       text,
  email                      text,
  telefone                   text,
  polo                       text,
  curso                      text,
  instituicao                text,
  subprocesso                text,
  data_chegada               text,
  data_previsao              text,
  data_conclusao             text,
  situacao_atendimento_raw   text,
  situacao_deferimento_raw   text,
  status                     text not null check (status in (
    'open', 'lost_canceled', 'lost_confirmed', 'won_reverted', 'unknown'
  )),
  first_snapshot_id          uuid,
  last_snapshot_id           uuid,
  first_seen_at              timestamptz not null default now(),
  last_seen_at               timestamptz not null default now(),
  last_status_change_at      timestamptz not null default now(),
  data                       jsonb not null default '{}'::jsonb
);

create index if not exists caa_protocols_status_idx       on caa_protocols (status);
create index if not exists caa_protocols_rgm_idx          on caa_protocols (rgm);
create index if not exists caa_protocols_last_seen_idx    on caa_protocols (last_seen_at desc);
create index if not exists caa_protocols_status_change_idx
  on caa_protocols (last_status_change_at desc);

create table if not exists caa_protocol_transitions (
  id                serial primary key,
  protocolo         text not null,
  rgm               text,
  from_status       text,
  to_status         text not null,
  from_raw_att      text,
  from_raw_def      text,
  to_raw_att        text,
  to_raw_def        text,
  snapshot_id       uuid,
  changed_at        timestamptz not null default now()
);

create index if not exists caa_transitions_protocolo_idx on caa_protocol_transitions (protocolo);
create index if not exists caa_transitions_changed_idx
  on caa_protocol_transitions (changed_at desc);
create index if not exists caa_transitions_to_status_changed_idx
  on caa_protocol_transitions (to_status, changed_at desc);
