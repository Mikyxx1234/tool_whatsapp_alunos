alter table activation_dispatch_events
  drop constraint if exists activation_dispatch_events_category_check;
alter table activation_dispatch_events
  add constraint activation_dispatch_events_category_check check (
    category in (
      'docs-pendentes', 'financeiro', 'acessos-blackboard',
      'processos-caa', 'provavel-evasao', 'aguardando-inicio'
    )
  );

alter table activation_manual_outcomes
  drop constraint if exists activation_manual_outcomes_category_check;
alter table activation_manual_outcomes
  add constraint activation_manual_outcomes_category_check check (
    category in (
      'docs-pendentes', 'financeiro', 'acessos-blackboard',
      'processos-caa', 'provavel-evasao', 'aguardando-inicio'
    )
  );
