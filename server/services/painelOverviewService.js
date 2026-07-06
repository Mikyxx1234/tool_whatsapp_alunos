import { query } from '../db/client.js';
import { getActivationConversion } from './activationConversionService.js';
import * as manualOutcomesRepo from '../repositories/manualOutcomesRepository.js';
import * as consultorMetasRepo from '../repositories/consultorMetasRepository.js';
import { buildConsultorResolver } from '../utils/consultorNomeResolver.js';
import { fetchConsultoresCatalogo } from '../utils/fetchConsultoresCatalogo.js';
import {
  normalizeOrigemAtivacaoFilter,
  origemFilterToGroupKey,
  sqlOutcomeLinkedToResponseExists,
  isOrigemMovimentacaoInterna,
} from '../utils/origemAtivacaoFilter.js';
import {
  buildAlertas,
  buildMetaStatus,
  buildProjecaoMeta,
  brtWorkProgress,
  fetchConversaoPorBase,
  fetchDiarioAtivacoes,
  fetchEvolucaoDiaria,
  fetchPendentesInsights,
} from './painelInsightsService.js';
import { PAINEL_PERFIS, resolvePainelPerfil } from '../utils/painelPerfis.js';

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function parseRange(fromRaw, toRaw) {
  const from = fromRaw && DATE_RE.test(String(fromRaw)) ? String(fromRaw) : null;
  const to = toRaw && DATE_RE.test(String(toRaw)) ? String(toRaw) : null;
  if (from && to && from > to) return { from: to, to: from };
  return { from, to };
}

function anoMesFromDate(ymd) {
  if (!ymd || !DATE_RE.test(ymd)) {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
  }
  return ymd.slice(0, 7);
}

function periodFromOpts(from, to, periodDays, conversion) {
  if (from || to) return { from, to };
  const toYmd = new Date().toLocaleDateString('en-CA', { timeZone: 'America/Sao_Paulo' });
  const start = new Date();
  start.setDate(start.getDate() - (periodDays - 1));
  const fromYmd = start.toLocaleDateString('en-CA', { timeZone: 'America/Sao_Paulo' });
  return {
    from: conversion.filters?.since?.slice(0, 10) || fromYmd,
    to: toYmd,
  };
}

/**
 * Marcados no período agrupados por consultor que registrou a marcação.
 * @param {{ from?: string|null, to?: string|null, category?: string|null, origem_ativacao?: string|null }} range
 */
async function marcadosPorConsultor(range) {
  const fromDate = range.from ? new Date(range.from + 'T00:00:00.000Z') : null;
  let toDate = null;
  if (range.to) {
    const d = new Date(range.to + 'T00:00:00.000Z');
    d.setUTCDate(d.getUTCDate() + 1);
    toDate = d;
  }
  const category = range.category ? String(range.category).trim() : null;
  const origemAtivacao = normalizeOrigemAtivacaoFilter(range.origem_ativacao);
  const catCond = category ? 'and category = $3' : '';
  const origemOutcomeCond = origemAtivacao
    ? `and ${sqlOutcomeLinkedToResponseExists('amo', origemAtivacao)}`
    : '';
  const params = category ? [fromDate, toDate, category] : [fromDate, toDate];

  const { rows } = await query(
    `select
        consultor_nome,
        count(*)::int as total_marcado,
        count(*) filter (where outcome = 'revertido')::int as total_revertido,
        count(*) filter (where outcome = 'confirmado')::int as total_confirmado
       from activation_manual_outcomes amo
      where ($1::timestamptz is null or occurred_at >= $1)
        and ($2::timestamptz is null or occurred_at < $2)
        ${catCond}
        ${origemOutcomeCond}
      group by consultor_nome
      order by total_marcado desc, consultor_nome`,
    params
  );
  return rows.map((r) => ({
    consultor_nome: r.consultor_nome,
    total_marcado: Number(r.total_marcado) || 0,
    total_revertido: Number(r.total_revertido) || 0,
    total_confirmado: Number(r.total_confirmado) || 0,
  }));
}

/** Enumera todos os dias YYYY-MM-DD entre from e to (inclusivo), em UTC puro. */
function eachDay(fromYmd, toYmd) {
  const days = [];
  if (!fromYmd || !toYmd) return days;
  const cur = new Date(fromYmd + 'T00:00:00.000Z');
  const end = new Date(toYmd + 'T00:00:00.000Z');
  let guard = 0;
  while (cur <= end && guard < 400) {
    days.push(cur.toISOString().slice(0, 10));
    cur.setUTCDate(cur.getUTCDate() + 1);
    guard += 1;
  }
  return days;
}

/**
 * Monta o calendário de metas: para cada dia do período, compara os marcados do
 * time com a meta diária. Fim de semana e dias futuros ficam neutros.
 * @param {{ from: string, to: string, hojeBrt: string, metaDia: number, evolucao: Array<{dia: string, marcados: number, revertidos: number}> }} params
 */
function buildCalendarioMeta({ from, to, hojeBrt, metaDia, evolucao }) {
  const marcMap = new Map(evolucao.map((e) => [e.dia, e]));
  const meta = Number(metaDia) || 0;

  const dias = eachDay(from, to).map((dia) => {
    const ev = marcMap.get(dia);
    const marcados = ev?.marcados ?? 0;
    const revertidos = ev?.revertidos ?? 0;
    const dow = new Date(dia + 'T00:00:00.000Z').getUTCDay(); // 0=dom 6=sáb
    const fimDeSemana = dow === 0 || dow === 6;
    const futuro = dia > hojeBrt;
    const hoje = dia === hojeBrt;

    let status;
    if (futuro) status = 'futuro';
    else if (meta <= 0) status = 'sem_meta';
    else if (fimDeSemana && marcados === 0) status = 'fim_semana';
    else if (marcados >= meta) status = 'bateu';
    else if (marcados >= meta * 0.7) status = 'quase';
    else if (marcados > 0) status = 'abaixo';
    else status = 'zero';

    return {
      dia,
      dow,
      marcados,
      revertidos,
      meta_dia: meta,
      pct: meta > 0 ? marcados / meta : null,
      status,
      hoje,
      fim_de_semana: fimDeSemana,
    };
  });

  const diasUteis = dias.filter((d) => d.status !== 'futuro' && d.status !== 'fim_semana' && d.status !== 'sem_meta');
  const bateram = diasUteis.filter((d) => d.status === 'bateu').length;

  return {
    dias,
    meta_dia: meta,
    resumo: {
      dias_avaliados: diasUteis.length,
      dias_bateram: bateram,
      taxa_sucesso: diasUteis.length > 0 ? bateram / diasUteis.length : null,
    },
  };
}

/**
 * @param {{ from?: string|null, to?: string|null, period_days?: number, perfil?: string|null, ref_dia?: string|null, origem_ativacao?: string|null, catalogo?: Array<{nome?: string, username?: string}> }} opts
 */
export async function getPainelOverview(opts = {}) {
  const { from, to } = parseRange(opts.from, opts.to);
  const periodDays = Math.min(Math.max(Number(opts.period_days) || 30, 1), 365);
  const perfil = resolvePainelPerfil(opts.perfil);
  const isCaa = perfil.modo === 'caa';
  const category = perfil.category;
  const origemAtivacao = isCaa ? normalizeOrigemAtivacaoFilter(opts.origem_ativacao) : null;
  const refDiaRaw = opts.ref_dia && DATE_RE.test(String(opts.ref_dia)) ? String(opts.ref_dia) : null;

  const convOpts = refDiaRaw
    ? { category, from: refDiaRaw, to: refDiaRaw, origem_ativacao: origemAtivacao }
    : from || to
      ? { category, from, to, origem_ativacao: origemAtivacao }
      : { category, period_days: periodDays, origem_ativacao: origemAtivacao };

  const statsFrom = refDiaRaw || from;
  const statsTo = refDiaRaw || to;

  const [conversion, meuPainel] = await Promise.all([
    getActivationConversion(convOpts),
    manualOutcomesRepo.meuPainelStats({
      consultor: null,
      from: statsFrom,
      to: statsTo,
      category,
      origem_ativacao: origemAtivacao,
    }),
  ]);

  const periodRange = periodFromOpts(from, to, periodDays, conversion);
  const refMonth = anoMesFromDate(refDiaRaw || to || from || null);
  const catalogo = await fetchConsultoresCatalogo(opts.catalogo);
  const [metasRows] = await Promise.all([
    consultorMetasRepo.listMetas({ ano_mes: refMonth }),
  ]);

  const hojeBrt = new Date().toLocaleDateString('en-CA', { timeZone: 'America/Sao_Paulo' });
  const refDia = refDiaRaw
    && refDiaRaw >= periodRange.from
    && refDiaRaw <= periodRange.to
    ? refDiaRaw
    : null;
  const equipeRefDia = refDia || hojeBrt;
  // Meta do time: sempre Processos CAA completo (ignora filtro origem_ativacao).
  const porConsultorHojeMeta = isCaa
    ? await marcadosPorConsultor({ from: equipeRefDia, to: equipeRefDia, category })
    : [];
  const porConsultorHoje = isCaa
    ? await marcadosPorConsultor({ from: equipeRefDia, to: equipeRefDia, category, origem_ativacao: origemAtivacao })
    : [];

  const allNames = [
    ...metasRows.map((m) => m.consultor_nome),
    ...porConsultorHoje.map((r) => r.consultor_nome),
    ...catalogo.map((c) => c.nome),
  ];
  const resolver = buildConsultorResolver(allNames, catalogo);
  const work = brtWorkProgress();

  const metaByKey = new Map();
  for (const m of metasRows) {
    const key = resolver.resolveKey(m.consultor_nome);
    if (!key) continue;
    metaByKey.set(key, Number(m.meta_marcados) || 0);
  }

  const [pendentesInsights, evolucaoDiaria, evolucaoDiariaMeta, diarioAtivacoes, porBaseRaw] = await Promise.all([
    isCaa ? fetchPendentesInsights({ resolver, metaKeys: metaByKey, origem_ativacao: origemAtivacao }) : Promise.resolve({
      por_consultor: [],
      aging: { age_0_4h: 0, age_4_24h: 0, age_1_3d: 0, age_3d_plus: 0, total: 0 },
      definicao: null,
      escopo: null,
    }),
    isCaa
      ? fetchEvolucaoDiaria({ ...periodRange, category, origem_ativacao: origemAtivacao })
      : Promise.resolve([]),
    isCaa
      ? fetchEvolucaoDiaria({ ...periodRange, category })
      : Promise.resolve([]),
    fetchDiarioAtivacoes(
      isCaa && isOrigemMovimentacaoInterna(origemAtivacao)
        ? { from: periodRange.from, to: periodRange.to, category: null }
        : { ...periodRange, category }
    ),
    isCaa ? fetchConversaoPorBase(refDia ? { ...periodRange, from: refDia, to: refDia } : periodRange, { origem_ativacao: origemAtivacao }) : Promise.resolve([]),
  ]);

  const porBase = isCaa
    ? (origemAtivacao
      ? porBaseRaw.filter((b) => b.key === origemFilterToGroupKey(origemAtivacao))
      : porBaseRaw.filter((b) => String(b.key || '').startsWith('processos-caa')))
      .map((b) => ({ ...b, unique_dispatched: null, unique_responders: null, taxa_resposta: null }))
    : [];

  const hojeByKey = new Map();
  for (const row of porConsultorHoje) {
    const key = resolver.resolveKey(row.consultor_nome);
    if (!key) continue;
    const prev = hojeByKey.get(key) || {
      total_marcado: 0,
      total_revertido: 0,
      total_confirmado: 0,
    };
    hojeByKey.set(key, {
      total_marcado: prev.total_marcado + row.total_marcado,
      total_revertido: prev.total_revertido + row.total_revertido,
      total_confirmado: prev.total_confirmado + row.total_confirmado,
    });
  }

  const hojeMetaByKey = new Map();
  for (const row of porConsultorHojeMeta) {
    const key = resolver.resolveKey(row.consultor_nome);
    if (!key) continue;
    const prev = hojeMetaByKey.get(key) || {
      total_marcado: 0,
      total_revertido: 0,
      total_confirmado: 0,
    };
    hojeMetaByKey.set(key, {
      total_marcado: prev.total_marcado + row.total_marcado,
      total_revertido: prev.total_revertido + row.total_revertido,
      total_confirmado: prev.total_confirmado + row.total_confirmado,
    });
  }

  const pendentesByKey = new Map(
    pendentesInsights.por_consultor.map((p) => [resolver.resolveKey(p.consultor_nome), p])
  );

  const equipeKeys = isCaa ? new Set([...metaByKey.keys()]) : new Set();

  const equipe = isCaa ? [...equipeKeys].map((key) => {
    const hojeRow = hojeByKey.get(key);
    const metaDiaria = metaByKey.get(key) ?? null;
    const marcadoHoje = hojeRow?.total_marcado ?? 0;
    const revertidoHoje = hojeRow?.total_revertido ?? 0;
    const pctMeta = metaDiaria != null && metaDiaria > 0 ? marcadoHoje / metaDiaria : null;
    const taxaReversao = marcadoHoje > 0 ? revertidoHoje / marcadoHoje : null;
    const pend = pendentesByKey.get(key);
    const row = {
      consultor_nome: resolver.displayName(key),
      total_marcado: marcadoHoje,
      total_revertido: revertidoHoje,
      total_confirmado: hojeRow?.total_confirmado ?? 0,
      meta_diaria: metaDiaria,
      meta_marcados: metaDiaria,
      pct_meta: pctMeta,
      taxa_reversao: taxaReversao,
      pendentes: pend?.pendentes ?? 0,
      pendentes_24h_plus: (pend?.age_4_24h ?? 0) + (pend?.age_1_3d ?? 0) + (pend?.age_3d_plus ?? 0),
      status_meta: 'sem_meta',
    };
    if (refDia && refDia !== hojeBrt) {
      const pct = row.pct_meta ?? 0;
      row.status_meta = row.meta_diaria == null || row.meta_diaria <= 0
        ? 'sem_meta'
        : pct >= 1
          ? 'batendo'
          : pct >= 0.7
            ? 'em_risco'
            : 'atrasado';
    } else {
      row.status_meta = buildMetaStatus(row, work);
    }
    return row;
  }).sort((a, b) => b.total_marcado - a.total_marcado || a.consultor_nome.localeCompare(b.consultor_nome, 'pt-BR')) : [];

  if (isCaa) {
    equipe.forEach((row, idx) => {
      row.ranking = idx + 1;
    });
  }

  const metaTotalFixo = isCaa
    ? [...metaByKey.values()].reduce((s, m) => s + (Number(m) || 0), 0)
    : 0;
  const marcadoTotalMeta = isCaa
    ? [...equipeKeys].reduce((s, key) => s + (hojeMetaByKey.get(key)?.total_marcado ?? 0), 0)
    : 0;

  const metas_resumo = isCaa ? {
    consultores_com_meta: equipe.filter((e) => e.meta_diaria != null).length,
    meta_total: metaTotalFixo,
    marcado_total: marcadoTotalMeta,
    pct_meta_global: metaTotalFixo > 0 ? marcadoTotalMeta / metaTotalFixo : null,
    meta_tipo: 'diaria',
  } : {
    consultores_com_meta: 0,
    meta_total: 0,
    marcado_total: 0,
    pct_meta_global: null,
    meta_tipo: 'diaria',
  };

  const calendario_meta = isCaa ? buildCalendarioMeta({
    from: periodRange.from,
    to: periodRange.to,
    hojeBrt,
    metaDia: metaTotalFixo,
    evolucao: evolucaoDiariaMeta,
  }) : { dias: [], meta_dia: 0, resumo: { dias_avaliados: 0, dias_bateram: 0, taxa_sucesso: null } };

  const funil = isCaa ? {
    total_atribuido: meuPainel.total_atribuido,
    total_marcado: meuPainel.total_marcado,
    total_revertido: meuPainel.total_revertido,
    taxa_marcacao: meuPainel.total_atribuido > 0
      ? meuPainel.total_marcado / meuPainel.total_atribuido
      : null,
    taxa_reversao: meuPainel.taxa_reversao,
    taxa_resposta: null,
  } : {
    total_atribuido: conversion.kpis?.unique_dispatched ?? 0,
    total_marcado: 0,
    total_revertido: 0,
    total_responderam: conversion.kpis?.unique_responders ?? 0,
    total_opt_out: conversion.kpis?.unique_opt_outs ?? 0,
    taxa_marcacao: null,
    taxa_reversao: null,
    taxa_resposta: conversion.kpis?.response_rate ?? null,
  };

  const projecao_meta = isCaa && (!refDia || refDia === hojeBrt) ? buildProjecaoMeta(metas_resumo) : {
    projecao_fim_dia: null,
    pct_projecao: null,
    elapsed_hours: 0,
    total_hours: 10,
    pct_dia: 0,
  };

  const alertas = buildAlertas({
    equipe,
    pendentes: pendentesInsights,
    aging: pendentesInsights.aging,
    metas_resumo,
    por_base: porBase,
    funil,
    projecao_meta,
    modo: perfil.modo,
  });

  return {
    perfil: {
      id: perfil.id,
      label: perfil.label,
      category: perfil.category,
      modo: perfil.modo,
    },
    perfis_disponiveis: PAINEL_PERFIS.map((p) => ({ id: p.id, label: p.label, modo: p.modo })),
    evolucao_tipo: isCaa ? 'marcados' : 'atribuidos',
    period: {
      from: periodRange.from,
      to: periodRange.to,
      period_days: from || to ? null : periodDays,
      ano_mes_meta: refMonth,
      meta_referencia_dia: refDia || hojeBrt,
      ref_dia: refDia,
      origem_ativacao: origemAtivacao,
    },
    conversao: {
      total_dispatches: conversion.kpis?.total_dispatches ?? 0,
      unique_dispatched: conversion.kpis?.unique_dispatched ?? 0,
      unique_responders: conversion.kpis?.unique_responders ?? 0,
      response_rate: conversion.kpis?.response_rate ?? 0,
      unique_reverted: conversion.kpis?.unique_reverted ?? 0,
      whatsapp_metrics: conversion.kpis?.whatsapp_metrics !== false,
    },
    meu_painel: meuPainel,
    equipe,
    metas_resumo,
    funil,
    projecao_meta,
    pendentes: pendentesInsights,
    evolucao_diaria: evolucaoDiaria,
    diario_ativacoes: diarioAtivacoes,
    calendario_meta,
    por_base: porBase,
    alertas,
    generated_at: new Date().toISOString(),
  };
}
