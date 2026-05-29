-- =============================================================================
-- Migration 005 — Views consolidadas para dashboards (régua + disparador)
-- =============================================================================

-- -----------------------------------------------------------------------------
-- vw_students_journey_summary — total por fluxo e status
-- -----------------------------------------------------------------------------
create or replace view vw_students_journey_summary as
select
  coalesce(fluxo, 'INDEFINIDO')                       as fluxo,
  count(*)::int                                       as total_students,
  sum(case when status = 'ativo'     then 1 else 0 end)::int as total_ativos,
  sum(case when status = 'iniciado'  then 1 else 0 end)::int as total_iniciados,
  sum(case when status = 'inativo'   then 1 else 0 end)::int as total_inativos,
  sum(case when status = 'cancelado' then 1 else 0 end)::int as total_cancelados,
  avg(gap_dias)::numeric(10,2)                        as gap_medio
from students
group by coalesce(fluxo, 'INDEFINIDO')
order by 1;

-- -----------------------------------------------------------------------------
-- vw_scheduled_events_today — visão do scheduler do dia corrente
-- -----------------------------------------------------------------------------
create or replace view vw_scheduled_events_today as
select
  sum(case when status = 'pending'    and execution_date::date = current_date then 1 else 0 end)::int as total_pending_today,
  sum(case when status = 'processing' then 1 else 0 end)::int                                          as total_processing,
  sum(case when status = 'failed'     and processed_at::date = current_date then 1 else 0 end)::int    as total_failed_today,
  sum(case when status = 'sent'       and processed_at::date = current_date then 1 else 0 end)::int    as total_sent_today,
  sum(case when status = 'pending'    and execution_date <= now() then 1 else 0 end)::int              as total_pending_due,
  sum(case when status = 'pending'    and execution_date >  now() then 1 else 0 end)::int              as total_pending_future
from scheduled_events;

-- -----------------------------------------------------------------------------
-- vw_student_timeline — junta timeline + logs + interações por aluno
-- -----------------------------------------------------------------------------
create or replace view vw_student_timeline as
select
  ste.id           as event_id,
  ste.student_id,
  ste.event_type,
  ste.title,
  ste.description,
  ste.metadata,
  ste.created_at,
  s.nome           as student_name,
  s.fluxo          as student_fluxo,
  s.status         as student_status
from student_timeline_events ste
join students s on s.id = ste.student_id
order by ste.created_at desc;

-- -----------------------------------------------------------------------------
-- vw_whatsapp_campaign_summary — recriar incluindo mode/source
-- (substitui a view criada na migration 001)
-- -----------------------------------------------------------------------------
drop view if exists vw_whatsapp_campaign_summary;

create or replace view vw_whatsapp_campaign_summary as
select
  c.id,
  c.name,
  c.mode,
  c.source,
  c.is_automated,
  ct.code               as campaign_type,
  ct.name               as campaign_type_name,
  c.template_name,
  c.template_language,
  c.template_category,
  c.status,
  c.total_contacts,
  c.total_valid,
  c.total_invalid,
  c.total_duplicates,
  c.total_sent,
  c.total_failed,
  c.total_interacted,
  c.total_not_interacted,
  case
    when c.total_valid > 0 then round(100.0 * c.total_sent / c.total_valid, 2)
    else 0
  end as taxa_envio,
  case
    when c.total_sent > 0 then round(100.0 * c.total_interacted / c.total_sent, 2)
    else 0
  end as taxa_interacao,
  c.created_at,
  c.started_at,
  c.finished_at
from whatsapp_campaigns c
left join campaign_types ct on ct.id = c.campaign_type_id;
