-- 037_mv_aluno_por_telefone.sql
-- Resolve o nome do aluno por TELEFONE quando ele não vem no raw_payload da
-- activation_responses nem nas demais fontes (caa_protocols, datacrazy_lead_cache,
-- matriculados por CPF/RGM). Consolida nome/rgm/cpf das bases acadêmicas indexado
-- por telefone normalizado para um lookup O(1) no Meu Painel.
--
-- Normalização canônica BR: DDD (2 dígitos) + últimos 8 dígitos do assinante.
-- Isso unifica variações com/sem prefixo 55 e com/sem o 9 do celular:
--   "5511958291608" -> "1158291608"
--   "11958291608"   -> "1158291608"
--   "1158291608"    -> "1158291608"

create or replace function normalize_phone_br(p text)
returns text
language sql
immutable
as $$
  with c as (
    select regexp_replace(coalesce(p, ''), '[^0-9]', '', 'g') as d
  ),
  s as (
    select case
      when length(d) >= 12 and left(d, 2) = '55' then substr(d, 3)
      else d
    end as d
    from c
  )
  select case
    when length(d) >= 10 then substr(d, 1, 2) || right(d, 8)
    when length(d) >= 8  then right(d, 8)
    else nullif(d, '')
  end
  from s
$$;

drop materialized view if exists mv_aluno_por_telefone;

create materialized view mv_aluno_por_telefone as
with src as (
  -- matriculados: só o último snapshot (base completa e autoritativa ~33k;
  -- a tabela acumula 700k+ linhas em todos os snapshots, não vale varrer tudo).
  select
    normalize_phone_br(mr.data->>'Fone celular') as phone_norm,
    nullif(trim(mr.data->>'Nome'), '')           as nome,
    nullif(trim(mr.data->>'RGM'), '')            as rgm,
    nullif(trim(mr.data->>'CPF'), '')            as cpf,
    ms.created_at
  from matriculados_rows mr
  join matriculados_snapshots ms on ms.id = mr.snapshot_id
  where mr.snapshot_id = (
    select id from matriculados_snapshots order by created_at desc limit 1
  )

  union all
  -- processos_caa: todos os snapshots (base pequena, ~900 linhas, é delta diário).
  select
    normalize_phone_br(pr.data->>'Celular'),
    nullif(trim(pr.data->>'Aluno'), ''),
    nullif(trim(pr.data->>'RGM'), ''),
    nullif(trim(pr.data->>'CPF'), ''),
    ps.created_at
  from processos_caa_rows pr
  join processos_caa_snapshots ps on ps.id = pr.snapshot_id

  union all
  -- docs_pendentes: todos os snapshots.
  select
    normalize_phone_br(dr.data->>'Celular'),
    nullif(trim(dr.data->>'Nome Aluno'), ''),
    nullif(trim(dr.data->>'Rgm'), ''),
    nullif(trim(dr.data->>'Cpf Aluno'), ''),
    ds.created_at
  from docs_pendentes_rows dr
  join docs_pendentes_snapshots ds on ds.id = dr.snapshot_id

  union all
  -- acessos_blackboard: todos os snapshots (não tem CPF).
  select
    normalize_phone_br(abr.data->>'Celular'),
    nullif(trim(abr.data->>'Aluno'), ''),
    nullif(trim(abr.data->>'RGM'), ''),
    null,
    abs2.created_at
  from acessos_blackboard_rows abr
  join acessos_blackboard_snapshots abs2 on abs2.id = abr.snapshot_id
)
select distinct on (phone_norm)
  phone_norm,
  nome,
  rgm,
  cpf,
  created_at
from src
where phone_norm is not null
  and nome is not null
order by phone_norm, created_at desc;

-- Índice único: exigido pelo REFRESH MATERIALIZED VIEW CONCURRENTLY e acelera o lookup.
create unique index if not exists mv_aluno_por_telefone_phone_uidx
  on mv_aluno_por_telefone (phone_norm);
