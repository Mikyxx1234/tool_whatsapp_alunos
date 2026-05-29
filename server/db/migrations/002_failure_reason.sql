-- =============================================================================
-- Migration 002 — Classificação de falhas de envio
-- Permite distinguir "número não encontrado no WhatsApp" de outros erros,
-- viabilizando exportação cirúrgica dos leads inalcançáveis.
-- =============================================================================

alter table whatsapp_campaign_contacts
  add column if not exists failure_reason text;

-- enums "soft" via check (text para facilitar evolução)
do $$
begin
  if not exists (
    select 1 from information_schema.constraint_column_usage
    where constraint_name = 'whatsapp_campaign_contacts_failure_reason_check'
  ) then
    alter table whatsapp_campaign_contacts
      add constraint whatsapp_campaign_contacts_failure_reason_check
      check (failure_reason is null or failure_reason in (
        'not_on_whatsapp',   -- número sem WhatsApp / lead não encontrado
        'invalid_number',    -- formato/DDD inválido detectado pelo provedor
        'rate_limited',      -- excedeu limite do provedor
        'template_rejected', -- template inválido/rejeitado
        'auth_error',        -- token expirado / sem permissão
        'provider_error',    -- erro genérico do provedor
        'network_error',     -- timeout/conexão
        'unknown'            -- não classificado
      ));
  end if;
end$$;

create index if not exists idx_contacts_failure_reason
  on whatsapp_campaign_contacts(campaign_id, failure_reason)
  where failure_reason is not null;

-- View dedicada para "leads não encontrados / falhas de envio"
create or replace view vw_whatsapp_campaign_failed_contacts as
select
  cc.id                 as contact_id,
  cc.campaign_id,
  c.name                as campaign_name,
  ct.code               as campaign_type,
  cc.phone,
  cc.normalized_phone,
  cc.name,
  cc.email,
  cc.course,
  cc.origem,
  cc.cpf,
  cc.student_id,
  cc.validation_status,
  cc.send_status,
  cc.failure_reason,
  cc.error_message,
  cc.created_at,
  cc.sent_at
from whatsapp_campaign_contacts cc
join whatsapp_campaigns c on c.id = cc.campaign_id
left join campaign_types ct on ct.id = c.campaign_type_id
where
  cc.send_status = 'failed'
  or cc.validation_status in ('invalid','duplicate');
