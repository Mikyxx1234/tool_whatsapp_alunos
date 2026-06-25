-- Migration 036 — origem_ativacao em activation_responses (sub-tipo CAA: caa, caa_atm, caa_ia)
-- Usado no Meu Painel para diferenciar "processos CAA" vs "processos CAA_ATM".

alter table activation_responses
  add column if not exists origem_ativacao text;

create index if not exists activation_responses_origem_idx
  on activation_responses (origem_ativacao)
  where origem_ativacao is not null;
