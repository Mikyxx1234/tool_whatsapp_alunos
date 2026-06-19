import { getActivationRoster } from './activationService.js';
import { getRematriculaBaseStatus } from '../repositories/baseUploadRepository.js';

function sourceLabel(source) {
  if (source === 'siaa') return 'SIAA';
  if (source === 'portal-de-polos') return 'Portal de Polos';
  return '—';
}

/**
 * Resumo para card do painel Relatórios.
 */
export async function getRematriculaReportSummary() {
  const [baseStatus, roster] = await Promise.all([
    getRematriculaBaseStatus(),
    getActivationRoster('rematricula', { limit: 1, offset: 0 }),
  ]);

  const counts = roster.remat_subgrupo_counts ?? { adimplente: 0, inadimplente: 0 };
  const total_fila = (counts.adimplente ?? 0) + (counts.inadimplente ?? 0);
  const active = baseStatus.active_snapshot;
  const hintParts = [
    `${(counts.adimplente ?? 0).toLocaleString('pt-BR')} adimplente`,
    `${(counts.inadimplente ?? 0).toLocaleString('pt-BR')} inadimplente`,
  ];
  if (active) {
    hintParts.push(
      `base ${sourceLabel(active.source)} ${(baseStatus.active_row_count ?? 0).toLocaleString('pt-BR')} EM CURSO`
    );
  }

  return {
    total_fila,
    adimplente: counts.adimplente ?? 0,
    inadimplente: counts.inadimplente ?? 0,
    hint: hintParts.join(' · '),
    warning: roster.warning ?? null,
    remat_base: active
      ? {
          id: active.id,
          file_name: active.file_name,
          row_count: active.row_count,
          created_at: active.created_at,
          source: active.source,
        }
      : null,
    active_source: baseStatus.active_source,
  };
}

/**
 * @param {{ subgrupo?: 'adimplente'|'inadimplente'|null, limit?: number, offset?: number }} opts
 */
export async function getRematriculaReportDetail(opts = {}) {
  const subgrupoRaw = String(opts.subgrupo || 'all').toLowerCase();
  const rematSubgrupo =
    subgrupoRaw === 'adimplente' || subgrupoRaw === 'inadimplente' ? subgrupoRaw : null;
  const limit = Math.min(Math.max(parseInt(String(opts.limit), 10) || 200, 1), 500);
  const offset = Math.max(parseInt(String(opts.offset), 10) || 0, 0);

  const [summary, roster] = await Promise.all([
    getRematriculaReportSummary(),
    getActivationRoster('rematricula', {
      limit,
      offset,
      rematSubgrupo,
    }),
  ]);

  const items = (roster.items || []).map((row) => ({
    nome: row.nome,
    rgm: row.rgm,
    cpf: row.cpf,
    email: row.email,
    telefone: row.telefone,
    polo: row.polo,
    curso: row.curso,
    ciclo: row.ciclo,
    instituicao: row.instituicao ?? '',
    situacao_matricula: row.situacao_matricula,
    financeiro: row.remat_subgrupo === 'inadimplente' ? 'Inadimplente' : 'Adimplente',
    remat_subgrupo: row.remat_subgrupo,
    prior_activation_count: row.prior_activation_count ?? 0,
    last_dispatch_at: row.last_dispatch_at ?? null,
  }));

  return {
    summary,
    subgrupo: rematSubgrupo ?? 'all',
    total: roster.total ?? 0,
    total_fila: summary.total_fila,
    remat_subgrupo_counts: roster.remat_subgrupo_counts ?? {
      adimplente: summary.adimplente,
      inadimplente: summary.inadimplente,
    },
    items,
    offset,
    limit,
    generated_at: roster.generated_at ?? new Date().toISOString(),
  };
}
