-- 039_activation_manual_outcomes_upsert.sql
-- Dedupe por (category, rgm) e índice único para upsert no Meu Painel.

-- Mantém só o registro mais recente por par (category, rgm).
delete from activation_manual_outcomes a
using (
  select id,
         row_number() over (
           partition by category, rgm
           order by occurred_at desc, created_at desc
         ) as rn
  from activation_manual_outcomes
  where rgm is not null
) ranked
where a.id = ranked.id
  and ranked.rn > 1;

drop index if exists activation_manual_outcomes_cat_rgm_idx;

create unique index if not exists activation_manual_outcomes_cat_rgm_uidx
  on activation_manual_outcomes (category, rgm)
  where rgm is not null;
