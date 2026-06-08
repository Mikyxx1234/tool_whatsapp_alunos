-- Migration 028 — Relaxa UNIQUE pra (external_id, category, dia da resposta).
--
-- Problema corrigido (continuação da 027):
--   O `external_id` do DataCrazy/WhatsApp identifica a CONVERSA persistente
--   entre o número da escola e o número do aluno — NÃO a mensagem individual.
--   Mesmo external_id reaparece em campanhas futuras (mesmo número, meses
--   depois, novo dispatch). A UNIQUE (external_id, category) introduzida em
--   027 bloqueava a 2ª resposta legítima de uma nova campanha pra mesma
--   pessoa+categoria (ex: DOC hoje + DOC daqui 2 meses).
--
-- Mudança:
--   UNIQUE passa a incluir o dia da resposta (received_at::date). Idempotência
--   mantida dentro do mesmo dia (mesma conversa + mesma categoria + mesmo
--   dia = 1 resposta). Em dias diferentes, novas respostas podem entrar.
--   Usamos cast pra `date` (IMMUTABLE) em vez de date_trunc (STABLE) porque
--   Postgres exige expressão IMMUTABLE em índice único.
--
-- N8n correspondente (FORA deste repo): o NOT EXISTS da query INSERT também
-- precisa incluir o filtro temporal: `AND ar.received_at >= now() - interval '24 hours'`.

drop index if exists activation_responses_external_id_category_uidx;

-- `timestamptz at time zone 'UTC'` é IMMUTABLE (resultado fixo independente
-- do timezone da sessão); a partir disso podemos castar pra `date` de forma
-- determinística e usar em índice único.
create unique index if not exists activation_responses_external_id_category_day_uidx
  on activation_responses (
    external_id,
    category,
    ((received_at at time zone 'UTC')::date)
  )
  where external_id is not null;
