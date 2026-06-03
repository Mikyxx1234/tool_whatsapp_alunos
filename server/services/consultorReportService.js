/**
 * Relatório agregado por consultor responsável (CAA).
 *
 * FONTE da identidade: snapshot textual gravado em:
 *   - `activation_responses.consultor_responsavel_nome` (webhook do n8n)
 *   - `caa_protocols.consultor_responsavel_nome` (sync de desfecho CAA)
 *
 * O "consultor" aqui é quem ASSUMIU a conversa no DataCrazy após a resposta
 * (NÃO o operador que clicou em "Ativar"). Painel foca em CAA: a fonte de
 * reversões é `caa_protocols` cruzada com o nome do consultor capturado no
 * momento do desfecho.
 */
import { query } from '../db/client.js';

/**
 * @param {Object} opts
 * @param {number} [opts.periodDays=30]
 * @returns {Promise<{
 *   consultores: Array<{
 *     consultor_nome: string|null,
 *     caa_revertidos: number,
 *     caa_perdidos: number,
 *     caa_taxa_reversao: number,
 *     total_respostas: number,
 *     ultima_atribuicao: string|null,
 *   }>,
 *   filters: { period_days: number, since: string, now: string },
 *   totals: { caa_revertidos: number, caa_perdidos: number, total_respostas: number },
 *   generated_at: string,
 * }>}
 */
export async function getConsultorReport({ periodDays = 30 } = {}) {
  const safePeriod = Math.min(Math.max(parseInt(periodDays, 10) || 30, 1), 365);
  const now = new Date();
  const since = new Date(now.getTime() - safePeriod * 24 * 60 * 60 * 1000);

  const { rows: caaRows } = await query(
    `select
        consultor_responsavel_nome as consultor_nome,
        count(*) filter (where status = 'won_reverted')                  ::int as caa_revertidos,
        count(*) filter (where status in ('lost_canceled','lost_confirmed')) ::int as caa_perdidos,
        max(consultor_responsavel_updated_at) as ultima_atribuicao
       from caa_protocols
      where consultor_responsavel_nome is not null
        and consultor_responsavel_updated_at >= $1
      group by consultor_responsavel_nome`,
    [since]
  );

  const { rows: respRows } = await query(
    `select
        consultor_responsavel_nome as consultor_nome,
        count(*)::int as total_respostas
       from activation_responses
      where consultor_responsavel_nome is not null
        and received_at >= $1
      group by consultor_responsavel_nome`,
    [since]
  );

  const map = new Map();
  for (const r of caaRows) {
    map.set(r.consultor_nome, {
      consultor_nome: r.consultor_nome,
      caa_revertidos: Number(r.caa_revertidos) || 0,
      caa_perdidos: Number(r.caa_perdidos) || 0,
      total_respostas: 0,
      ultima_atribuicao: r.ultima_atribuicao ? new Date(r.ultima_atribuicao).toISOString() : null,
    });
  }
  for (const r of respRows) {
    const existing = map.get(r.consultor_nome);
    if (existing) {
      existing.total_respostas = Number(r.total_respostas) || 0;
    } else {
      map.set(r.consultor_nome, {
        consultor_nome: r.consultor_nome,
        caa_revertidos: 0,
        caa_perdidos: 0,
        total_respostas: Number(r.total_respostas) || 0,
        ultima_atribuicao: null,
      });
    }
  }

  const consultores = [...map.values()].map((c) => {
    const denom = c.caa_revertidos + c.caa_perdidos;
    return {
      ...c,
      caa_taxa_reversao: denom > 0 ? c.caa_revertidos / denom : 0,
    };
  });

  consultores.sort((a, b) => {
    if (b.caa_revertidos !== a.caa_revertidos) return b.caa_revertidos - a.caa_revertidos;
    return (b.total_respostas || 0) - (a.total_respostas || 0);
  });

  const totals = consultores.reduce(
    (acc, c) => ({
      caa_revertidos: acc.caa_revertidos + c.caa_revertidos,
      caa_perdidos: acc.caa_perdidos + c.caa_perdidos,
      total_respostas: acc.total_respostas + c.total_respostas,
    }),
    { caa_revertidos: 0, caa_perdidos: 0, total_respostas: 0 }
  );

  return {
    consultores,
    filters: {
      period_days: safePeriod,
      since: since.toISOString(),
      now: now.toISOString(),
    },
    totals,
    generated_at: now.toISOString(),
  };
}
