import { query } from '../db/client.js';
import { aggregateMeuPainelOrigemCounts, getMeuPainelBaseLabel, getMeuPainelOrigemGroupKey } from '../utils/meuPainelLabels.js';
import {
  normalizeOrigemAtivacaoFilter,
  sqlOrigemAtivacaoCond,
  sqlOutcomeLinkedToResponseExists,
} from '../utils/origemAtivacaoFilter.js';

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function parseDateRange(from, to) {
  const fromDate = from && DATE_RE.test(from) ? new Date(from + 'T00:00:00.000Z') : null;
  let toDate = null;
  if (to && DATE_RE.test(to)) {
    const d = new Date(to + 'T00:00:00.000Z');
    d.setUTCDate(d.getUTCDate() + 1);
    toDate = d;
  }
  return { fromDate, toDate };
}

/** Horário comercial BRT para projeção de meta (8h–18h). */
function brtWorkProgress() {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Sao_Paulo',
    hour: 'numeric',
    hour12: false,
  }).formatToParts(new Date());
  const hour = Number(parts.find((p) => p.type === 'hour')?.value ?? 12);
  const start = 8;
  const end = 18;
  const totalHours = end - start;
  const elapsed = Math.min(Math.max(hour - start, 0), totalHours);
  return {
    hour,
    elapsed_hours: elapsed,
    total_hours: totalHours,
    pct_dia: totalHours > 0 ? elapsed / totalHours : 1,
  };
}

const OUTCOME_EXISTS = `
  exists (
    select 1
      from activation_manual_outcomes amo
     where amo.category = ar.category
       and (
         (
           nullif(trim(coalesce(ar.rgm, '')), '') is not null
           and amo.rgm is not null
           and regexp_replace(amo.rgm, '[^0-9]', '', 'g')
               = regexp_replace(coalesce(ar.rgm, ''), '[^0-9]', '', 'g')
           and length(regexp_replace(amo.rgm, '[^0-9]', '', 'g')) >= 5
         )
         or (
           nullif(trim(coalesce(ar.master_key, '')), '') is not null
           and amo.master_key is not null
           and amo.master_key = ar.master_key
         )
       )
  )
`;

const PENDENTE_ENGAGED_SQL = `
  (
    ar.response_kind in ('click', 'message')
    or ar.external_id like 'manual:%'
    or coalesce((ar.raw_payload->>'manual')::boolean, false)
  )
`;

/**
 * Pendentes = leads CAA que **responderam** (ou cadastro manual) e ainda não têm desfecho.
 * Não conta atribuições em massa sem resposta.
 *
 * @param {{
 *   resolver: { resolveKey: (n: string) => string, displayName: (k: string) => string },
 *   metaKeys?: Set<string>|null,
 *   origem_ativacao?: string|null,
 * }} ctx
 */
export async function fetchPendentesInsights(ctx) {
  const origemAtivacao = normalizeOrigemAtivacaoFilter(ctx.origem_ativacao);
  const origemCond = sqlOrigemAtivacaoCond('ar', origemAtivacao);
  const { rows } = await query(
    `
    select
      ar.consultor_responsavel_nome as consultor_nome,
      count(*)::int as pendentes,
      count(*) filter (
        where ar.received_at >= now() - interval '4 hours'
      )::int as age_0_4h,
      count(*) filter (
        where ar.received_at < now() - interval '4 hours'
          and ar.received_at >= now() - interval '24 hours'
      )::int as age_4_24h,
      count(*) filter (
        where ar.received_at < now() - interval '24 hours'
          and ar.received_at >= now() - interval '3 days'
      )::int as age_1_3d,
      count(*) filter (
        where ar.received_at < now() - interval '3 days'
      )::int as age_3d_plus
    from activation_responses ar
    where ar.category = 'processos-caa'
      and ar.consultor_responsavel_nome is not null
      and trim(ar.consultor_responsavel_nome) <> ''
      and ${PENDENTE_ENGAGED_SQL}
      and not (${OUTCOME_EXISTS})
      ${origemCond}
    group by ar.consultor_responsavel_nome
    order by pendentes desc, ar.consultor_responsavel_nome
    `
  );

  const metaKeys = ctx.metaKeys ?? null;

  const byKey = new Map();
  for (const r of rows) {
    const key = ctx.resolver.resolveKey(r.consultor_nome);
    if (!key) continue;
    if (metaKeys && metaKeys.size > 0 && !metaKeys.has(key)) continue;
    const prev = byKey.get(key) || {
      consultor_nome: ctx.resolver.displayName(key),
      pendentes: 0,
      age_0_4h: 0,
      age_4_24h: 0,
      age_1_3d: 0,
      age_3d_plus: 0,
    };
    byKey.set(key, {
      consultor_nome: ctx.resolver.displayName(key),
      pendentes: prev.pendentes + Number(r.pendentes || 0),
      age_0_4h: prev.age_0_4h + Number(r.age_0_4h || 0),
      age_4_24h: prev.age_4_24h + Number(r.age_4_24h || 0),
      age_1_3d: prev.age_1_3d + Number(r.age_1_3d || 0),
      age_3d_plus: prev.age_3d_plus + Number(r.age_3d_plus || 0),
    });
  }

  const por_consultor = [...byKey.values()].sort(
    (a, b) => b.pendentes - a.pendentes || a.consultor_nome.localeCompare(b.consultor_nome, 'pt-BR')
  );

  const aging = por_consultor.reduce(
    (acc, r) => ({
      age_0_4h: acc.age_0_4h + r.age_0_4h,
      age_4_24h: acc.age_4_24h + r.age_4_24h,
      age_1_3d: acc.age_1_3d + r.age_1_3d,
      age_3d_plus: acc.age_3d_plus + r.age_3d_plus,
      total: acc.total + r.pendentes,
    }),
    { age_0_4h: 0, age_4_24h: 0, age_1_3d: 0, age_3d_plus: 0, total: 0 }
  );

  return {
    por_consultor,
    aging,
    definicao: 'caa_responderam_sem_marcacao',
    escopo: metaKeys && metaKeys.size > 0 ? 'time_com_meta' : 'todos',
  };
}

/** @param {{ from?: string|null, to?: string|null, category?: string|null, origem_ativacao?: string|null }} range */
export async function fetchEvolucaoDiaria(range) {
  const { fromDate, toDate } = parseDateRange(range.from, range.to);
  const category = range.category ? String(range.category).trim() : null;
  const origemAtivacao = normalizeOrigemAtivacaoFilter(range.origem_ativacao);
  const catCond = category ? 'and amo.category = $3' : '';
  const origemOutcomeCond = origemAtivacao
    ? `and ${sqlOutcomeLinkedToResponseExists('amo', origemAtivacao)}`
    : '';
  const params = category ? [fromDate, toDate, category] : [fromDate, toDate];

  const { rows } = await query(
    `
    select
      (amo.occurred_at at time zone 'America/Sao_Paulo')::date as dia,
      count(*)::int as marcados,
      count(*) filter (where amo.outcome = 'revertido')::int as revertidos
    from activation_manual_outcomes amo
    where ($1::timestamptz is null or amo.occurred_at >= $1)
      and ($2::timestamptz is null or amo.occurred_at < $2)
      ${catCond}
      ${origemOutcomeCond}
    group by 1
    order by 1
    `,
    params
  );
  return rows.map((r) => ({
    dia: r.dia instanceof Date ? r.dia.toISOString().slice(0, 10) : String(r.dia).slice(0, 10),
    marcados: Number(r.marcados) || 0,
    revertidos: Number(r.revertidos) || 0,
  }));
}

/**
 * Monta resumo agregado a partir de linhas diárias.
 * @param {Array<{ disparos: number, pessoas: number, responderam: number, taxa_resposta: number|null }>} dias
 */
function buildDiarioResumo(dias) {
  const totalPessoas = dias.reduce((s, d) => s + d.pessoas, 0);
  const totalResp = dias.reduce((s, d) => s + d.responderam, 0);
  const totalDisparos = dias.reduce((s, d) => s + d.disparos, 0);
  const taxasValidas = dias.filter((d) => d.taxa_resposta != null).map((d) => d.taxa_resposta);
  const mediaTaxaDias = taxasValidas.length
    ? taxasValidas.reduce((s, t) => s + t, 0) / taxasValidas.length
    : null;
  return {
    dias_com_ativacao: dias.length,
    total_disparos: totalDisparos,
    total_pessoas: totalPessoas,
    total_responderam: totalResp,
    taxa_media_ponderada: totalPessoas > 0 ? totalResp / totalPessoas : null,
    taxa_media_dias: mediaTaxaDias,
  };
}

const FIN_SEGMENTOS = [
  { id: 'adimplente', label: 'Adimplente' },
  { id: 'inadimplente', label: 'Inadimplente' },
];

/**
 * Diário de ativações: para cada dia em que houve disparo (activation_dispatch_events
 * status='sent'), conta disparos, pessoas únicas e quantas responderam (click/message)
 * dentro da janela `staleHours` após o disparo. Taxa = responderam / pessoas.
 * Financeiro: quebra Adimplente vs Inadimplente (snapshot inadimplentes-vencidos).
 * @param {{ from?: string|null, to?: string|null, category?: string|null }} range
 * @param {{ staleHours?: number }} [opts]
 */
export async function fetchDiarioAtivacoes(range, opts = {}) {
  const { fromDate, toDate } = parseDateRange(range.from, range.to);
  const category = range.category ? String(range.category).trim() : null;
  if (!category) return { dias: [], resumo: null, segmentos: null };
  const staleHours = Number(opts.staleHours) || 72;
  const splitFinanceiro = category === 'financeiro';

  const segmentExpr = splitFinanceiro
    ? `case when ik.mk is not null then 'inadimplente' else 'adimplente' end`
    : `'all'`;

  const inadCte = splitFinanceiro
    ? `inad_keys as (
      select distinct 'RGM:' || regexp_replace(ir.data->>'RGM', '[^0-9]', '', 'g') as mk
        from inadimplentes_vencidos_rows ir
       where ir.snapshot_id = (
         select id from inadimplentes_vencidos_snapshots order by created_at desc limit 1
       )
         and length(regexp_replace(coalesce(ir.data->>'RGM', ''), '[^0-9]', '', 'g')) >= 5
    ),`
    : '';

  const inadJoin = splitFinanceiro ? 'left join inad_keys ik on ik.mk = d.master_key' : '';

  const { rows } = await query(
    `
    with ${inadCte}
    disp as (
      select
        d.master_key,
        d.created_at,
        (d.created_at at time zone 'America/Sao_Paulo')::date as dia,
        ${segmentExpr} as segmento
      from activation_dispatch_events d
      ${inadJoin}
      where d.status = 'sent'
        and d.category = $3
        and ($1::timestamptz is null or d.created_at >= $1)
        and ($2::timestamptz is null or d.created_at < $2)
        and d.master_key is not null
    ),
    disp_days as (
      select dia, segmento, count(*)::int as disparos, count(distinct master_key)::int as pessoas
      from disp
      group by dia, segmento
    ),
    resp as (
      select distinct d.dia, d.segmento, d.master_key
      from disp d
      join activation_responses r
        on r.category = $3
       and r.master_key = d.master_key
       and r.response_kind in ('click', 'message')
       and r.received_at >= d.created_at
       and r.received_at < d.created_at + ($4 || ' hours')::interval
    ),
    resp_days as (
      select dia, segmento, count(distinct master_key)::int as responderam
      from resp
      group by dia, segmento
    )
    select
      dd.dia,
      dd.segmento,
      dd.disparos,
      dd.pessoas,
      coalesce(rd.responderam, 0) as responderam
    from disp_days dd
    left join resp_days rd on rd.dia = dd.dia and rd.segmento = dd.segmento
    order by dd.dia, dd.segmento
    `,
    [fromDate, toDate, category, String(staleHours)]
  );

  const mapDia = (r) => {
    const pessoas = Number(r.pessoas) || 0;
    const responderam = Number(r.responderam) || 0;
    return {
      dia: r.dia instanceof Date ? r.dia.toISOString().slice(0, 10) : String(r.dia).slice(0, 10),
      disparos: Number(r.disparos) || 0,
      pessoas,
      responderam,
      taxa_resposta: pessoas > 0 ? responderam / pessoas : null,
    };
  };

  if (!splitFinanceiro) {
    const dias = rows.map(mapDia);
    return { dias, resumo: buildDiarioResumo(dias), segmentos: null };
  }

  const bySeg = new Map(FIN_SEGMENTOS.map((s) => [s.id, []]));
  for (const r of rows) {
    const seg = String(r.segmento || 'adimplente');
    if (!bySeg.has(seg)) bySeg.set(seg, []);
    bySeg.get(seg).push(mapDia(r));
  }

  const segmentos = FIN_SEGMENTOS.map((s) => {
    const dias = bySeg.get(s.id) || [];
    return { id: s.id, label: s.label, dias, resumo: buildDiarioResumo(dias) };
  });

  const diasTotais = [...rows].reduce((acc, r) => {
    const dia = r.dia instanceof Date ? r.dia.toISOString().slice(0, 10) : String(r.dia).slice(0, 10);
    const prev = acc.get(dia) || { dia, disparos: 0, pessoas: 0, responderam: 0, taxa_resposta: null };
    prev.disparos += Number(r.disparos) || 0;
    prev.pessoas += Number(r.pessoas) || 0;
    prev.responderam += Number(r.responderam) || 0;
    acc.set(dia, prev);
    return acc;
  }, new Map());
  const dias = [...diasTotais.values()].map((d) => ({
    ...d,
    taxa_resposta: d.pessoas > 0 ? d.responderam / d.pessoas : null,
  })).sort((a, b) => a.dia.localeCompare(b.dia));

  return { dias, resumo: buildDiarioResumo(dias), segmentos };
}

/** Evolução diária de atribuições (respostas recebidas) — perfis operacionais. */
export async function fetchEvolucaoDiariaAtribuidos(range) {
  const { fromDate, toDate } = parseDateRange(range.from, range.to);
  const category = range.category ? String(range.category).trim() : null;
  if (!category) return [];

  const { rows } = await query(
    `
    select
      (received_at at time zone 'America/Sao_Paulo')::date as dia,
      count(*)::int as atribuidos,
      count(*) filter (where response_kind in ('click', 'message'))::int as responderam
    from activation_responses
    where category = $3
      and ($1::timestamptz is null or received_at >= $1)
      and ($2::timestamptz is null or received_at < $2)
    group by 1
    order by 1
    `,
    [fromDate, toDate, category]
  );
  return rows.map((r) => ({
    dia: r.dia instanceof Date ? r.dia.toISOString().slice(0, 10) : String(r.dia).slice(0, 10),
    atribuidos: Number(r.atribuidos) || 0,
    responderam: Number(r.responderam) || 0,
  }));
}

/** @param {{ from?: string|null, to?: string|null }} range @param {{ origem_ativacao?: string|null }} [opts] */
export async function fetchConversaoPorBase(range, opts = {}) {
  const { fromDate, toDate } = parseDateRange(range.from, range.to);
  const origemAtivacao = normalizeOrigemAtivacaoFilter(opts.origem_ativacao);
  const origemAttribCond = sqlOrigemAtivacaoCond('v', origemAtivacao);
  const origemRespCond = sqlOrigemAtivacaoCond('ar', origemAtivacao);

  const [attribRows, marcadoRows] = await Promise.all([
    query(
      `
      select v.category, v.origem_ativacao, count(*)::int as atribuidos
        from vw_meu_painel_origem_ativacao v
       where ($1::timestamptz is null or v.received_at >= $1)
         and ($2::timestamptz is null or v.received_at < $2)
         ${origemAttribCond}
       group by v.category, v.origem_ativacao
      `,
      [fromDate, toDate]
    ),
    query(
      `
      with matched as (
        select distinct on (amo.id)
          amo.id as outcome_id,
          amo.outcome,
          ar.category,
          ar.origem_ativacao
        from activation_manual_outcomes amo
        join activation_responses ar
          on ar.category = amo.category
         and (
           (
             nullif(trim(coalesce(ar.rgm, '')), '') is not null
             and amo.rgm is not null
             and regexp_replace(amo.rgm, '[^0-9]', '', 'g')
                 = regexp_replace(coalesce(ar.rgm, ''), '[^0-9]', '', 'g')
             and length(regexp_replace(amo.rgm, '[^0-9]', '', 'g')) >= 5
           )
           or (
             nullif(trim(coalesce(ar.master_key, '')), '') is not null
             and amo.master_key is not null
             and ar.master_key = amo.master_key
           )
         )
         ${origemRespCond}
        where ($1::timestamptz is null or amo.occurred_at >= $1)
          and ($2::timestamptz is null or amo.occurred_at < $2)
        order by amo.id, ar.received_at desc
      )
      select
        category,
        origem_ativacao,
        count(*)::int as marcados,
        count(*) filter (where outcome = 'revertido')::int as revertidos
      from matched
      group by category, origem_ativacao
      `,
      [fromDate, toDate]
    ),
  ]);

  const attribMap = aggregateMeuPainelOrigemCounts(
    attribRows.rows.map((r) => ({
      category: r.category,
      origem_ativacao: r.origem_ativacao,
      total: Number(r.atribuidos) || 0,
    }))
  );

  const marcadoByKey = new Map();
  for (const r of marcadoRows.rows) {
    const k = getMeuPainelOrigemGroupKey(r.category, r.origem_ativacao);
    const label = getMeuPainelBaseLabel(r.category, r.origem_ativacao);
    const prev = marcadoByKey.get(k) || { key: k, label, marcados: 0, revertidos: 0 };
    marcadoByKey.set(k, {
      key: k,
      label,
      marcados: prev.marcados + Number(r.marcados || 0),
      revertidos: prev.revertidos + Number(r.revertidos || 0),
    });
  }

  const keys = new Set([...attribMap.map((a) => a.key), ...marcadoByKey.keys()]);
  return [...keys].map((key) => {
    const attr = attribMap.find((a) => a.key === key);
    const mar = marcadoByKey.get(key);
    const atribuidos = attr?.total ?? 0;
    const marcados = mar?.marcados ?? 0;
    // Reversão só faz sentido para Processos CAA. Demais bases (rematrícula,
    // financeiro, docs, etc.) não têm reversão — expõe null pra UI mostrar "—".
    const isCaa = String(key || '').startsWith('processos-caa');
    const revertidos = isCaa ? (mar?.revertidos ?? 0) : null;
    return {
      key,
      label: attr?.label || mar?.label || key,
      atribuidos,
      marcados,
      revertidos,
      taxa_marcacao: atribuidos > 0 ? marcados / atribuidos : null,
      taxa_reversao: isCaa && marcados > 0 ? (mar?.revertidos ?? 0) / marcados : null,
    };
  }).sort((a, b) => b.marcados - a.marcados || b.atribuidos - a.atribuidos);
}

/**
 * @param {object} params
 */
export function buildMetaStatus(row, work) {
  if (row.meta_diaria == null || row.meta_diaria <= 0) return 'sem_meta';
  const pct = row.pct_meta ?? 0;
  if (pct >= 1) return 'batendo';
  const expected = work.pct_dia;
  if (pct >= expected * 0.85) return 'em_risco';
  return 'atrasado';
}

/**
 * @param {{ marcado_total: number, meta_total: number }} metas
 */
export function buildProjecaoMeta(metas) {
  const work = brtWorkProgress();
  const { marcado_total, meta_total } = metas;
  if (!meta_total || meta_total <= 0) {
    return { projecao_fim_dia: null, pct_projecao: null, ...work };
  }
  const rate = work.elapsed_hours > 0 ? marcado_total / work.elapsed_hours : marcado_total;
  const remaining = Math.max(work.total_hours - work.elapsed_hours, 0);
  const projecao = Math.round(marcado_total + rate * remaining);
  return {
    ...work,
    projecao_fim_dia: projecao,
    pct_projecao: projecao / meta_total,
  };
}

/**
 * @param {object} data
 */
export function buildAlertas(data) {
  const candidates = [];
  const { equipe, aging, metas_resumo, por_base, funil, modo } = data;
  const isCaa = modo !== 'operacional';
  const push = (priority, alerta) => candidates.push({ priority, ...alerta });

  if (isCaa) {
    const semMarcar = equipe.filter((e) => e.meta_diaria && e.total_marcado === 0);
    if (semMarcar.length > 0) {
      push(55, {
        tipo: 'warning',
        titulo: `${semMarcar.length} consultor(es) sem marcar hoje`,
        detalhe: semMarcar.map((e) => e.consultor_nome).join(', '),
      });
    }

    if (aging.total > 0) {
      const velhos = aging.age_1_3d + aging.age_3d_plus;
      if (velhos > 0) {
        push(100, {
          tipo: 'danger',
          titulo: `${velhos} resposta(s) CAA sem marcação há +24h`,
          detalhe: `${aging.age_1_3d} entre 1–3 dias · ${aging.age_3d_plus} com +3 dias · só quem respondeu`,
        });
      }
      if (aging.age_4_24h > 0) {
        push(35, {
          tipo: 'warning',
          titulo: `${aging.age_4_24h} resposta(s) CAA aguardando há 4–24h`,
          detalhe: 'Responderam ao disparo e ainda não foram marcados',
        });
      }
    }

    const bateuMeta = equipe.filter((e) => e.status_meta === 'batendo');
    for (const e of bateuMeta) {
      push(85, {
        tipo: 'success',
        titulo: `${e.consultor_nome} bateu a meta do dia`,
        detalhe: `${e.total_marcado}/${e.meta_diaria} atendimentos`,
      });
    }

    const topConsultor = [...equipe].sort((a, b) => b.total_marcado - a.total_marcado)[0];
    if (topConsultor && topConsultor.total_marcado > 0) {
      push(65, {
        tipo: 'success',
        titulo: `Mais marcações hoje: ${topConsultor.consultor_nome}`,
        detalhe: `${topConsultor.total_marcado} marcado(s) · reversão ${topConsultor.taxa_reversao == null ? '—' : (topConsultor.taxa_reversao * 100).toFixed(0) + '%'}`,
      });
    }

    const atrasados = equipe.filter((e) => e.status_meta === 'atrasado');
    if (atrasados.length > 0) {
      push(75, {
        tipo: 'warning',
        titulo: `${atrasados.length} consultor(es) abaixo do ritmo`,
        detalhe: atrasados.map((e) => e.consultor_nome).join(', '),
      });
    }

    const topBase = [...(por_base || [])].sort((a, b) => (b.taxa_reversao ?? 0) - (a.taxa_reversao ?? 0))[0];
    if (topBase && topBase.marcados >= 3 && topBase.taxa_reversao != null) {
      push(60, {
        tipo: 'info',
        titulo: `Maior reversão: ${topBase.label}`,
        detalhe: `${(topBase.taxa_reversao * 100).toFixed(1).replace('.', ',')}% · ${topBase.revertidos}/${topBase.marcados} marcados`,
      });
    }

    if (funil?.total_atribuido > 0 && funil.taxa_marcacao != null && funil.taxa_marcacao < 0.3) {
      push(45, {
        tipo: 'info',
        titulo: 'Funil com baixa marcação no período',
        detalhe: `Só ${(funil.taxa_marcacao * 100).toFixed(1).replace('.', ',')}% dos atribuídos foram marcados`,
      });
    }

    if (metas_resumo?.meta_total > 0 && metas_resumo.pct_meta_global != null) {
      const proj = data.projecao_meta;
      if (proj?.pct_projecao != null && proj.pct_projecao < 0.85) {
        push(70, {
          tipo: 'warning',
          titulo: 'Time pode fechar abaixo da meta',
          detalhe: `Projeção: ${proj.projecao_fim_dia}/${metas_resumo.meta_total} (${(proj.pct_projecao * 100).toFixed(0)}%)`,
        });
      }
    }
  } else if (funil?.taxa_resposta != null && funil.taxa_resposta < 0.1 && funil.total_atribuido > 50) {
    push(80, {
      tipo: 'info',
      titulo: 'Taxa de resposta abaixo de 10%',
      detalhe: `${(funil.taxa_resposta * 100).toFixed(1).replace('.', ',')}% no período`,
    });
  } else if (!isCaa && funil?.taxa_resposta != null && funil.total_atribuido > 50) {
    push(55, {
      tipo: 'success',
      titulo: 'Taxa de resposta saudável',
      detalhe: `${(funil.taxa_resposta * 100).toFixed(1).replace('.', ',')}% no período`,
    });
  }

  const sorted = candidates.sort((a, b) => b.priority - a.priority);
  const selected = sorted.slice(0, 4);
  const hasPositive = selected.some((a) => a.tipo === 'success' || a.tipo === 'info');
  const bestPositive = sorted.find((a) => a.tipo === 'success' || a.tipo === 'info');
  if (!hasPositive && bestPositive && selected.length === 4) {
    selected[selected.length - 1] = bestPositive;
  }
  return selected.map(({ priority: _priority, ...alerta }) => alerta);
}

export { brtWorkProgress };
