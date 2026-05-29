-- Ativação na categoria provável evasão.

alter table activation_dispatches
  drop constraint if exists activation_dispatches_category_check;

alter table activation_dispatches
  add constraint activation_dispatches_category_check check (
    category in (
      'docs-pendentes',
      'financeiro',
      'acessos-blackboard',
      'processos-caa',
      'provavel-evasao'
    )
  );

alter table activation_dispatch_events
  drop constraint if exists activation_dispatch_events_category_check;

alter table activation_dispatch_events
  add constraint activation_dispatch_events_category_check check (
    category in (
      'docs-pendentes',
      'financeiro',
      'acessos-blackboard',
      'processos-caa',
      'provavel-evasao'
    )
  );
