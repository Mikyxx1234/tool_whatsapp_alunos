-- Ciclos arquivados das operações. Quando uma linha existe aqui, o disparador,
-- relatórios e dropdowns de ciclo excluem esse ciclo. Histórico em
-- activation_dispatch_events/activation_responses NÃO é tocado.
create table if not exists frozen_cycles (
  ciclo       text primary key,
  frozen_at   timestamptz not null default now(),
  frozen_by   text,
  reason      text
);

create index if not exists idx_frozen_cycles_frozen_at on frozen_cycles (frozen_at);
