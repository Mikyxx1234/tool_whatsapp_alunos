-- Migration 038 — views de contagem por origem_ativacao (coluna BASE no Meu Painel)

-- Linhas base para consultas filtradas (consultor, período, categoria).
create or replace view vw_meu_painel_origem_ativacao as
select
  ar.id,
  ar.category,
  coalesce(nullif(trim(ar.origem_ativacao), ''), '') as origem_ativacao,
  ar.consultor_responsavel_nome,
  ar.received_at
from activation_responses ar;

-- Totais globais por categoria + origem_ativacao (sem filtro de período/consultor).
create or replace view vw_meu_painel_origem_ativacao_counts as
select
  category,
  origem_ativacao,
  count(*)::int as total
from vw_meu_painel_origem_ativacao
group by category, origem_ativacao
order by total desc, category, origem_ativacao;
