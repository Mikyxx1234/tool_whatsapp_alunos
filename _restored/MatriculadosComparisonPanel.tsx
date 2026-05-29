import { RefreshCw } from 'lucide-react';
import type { MatriculadosComparisonBlock, MatriculadosComparisonResponse } from '../services/reportApi';

function Num({ n }: { n: number }) {
  return <span className="tabular-nums font-semibold text-gray-900">{n.toLocaleString('pt-BR')}</span>;
}

function BlockCard({ b }: { b: MatriculadosComparisonBlock }) {
  if (b.missing_other) {
    return (
      <div className="rounded-xl border border-amber-200 bg-amber-50/60 p-4">
        <h4 className="text-sm font-semibold text-amber-900">{b.title}</h4>
        <p className="text-xs text-amber-800 mt-2">
          Nenhum snapshot importado para esta base. Envie a planilha (Bases) ou rode o seed.
        </p>
      </div>
    );
  }

  const a = b.intersecao;
  const bOnly = b.matriculados_sem_intersecao;
  const out = b.na_outra_sem_matricula;

  let primaryLabel = '';
  let primaryDesc = '';
  let secondaryLabel = '';
  let secondaryDesc = '';
  let tertiaryLabel = '';
  let tertiaryDesc = '';

  if (b.mode === 'other_is_problem_list') {
    primaryLabel = 'Lista de ativação (matriculado + na base de pendência)';
    primaryDesc = 'Aparecem na matrícula e na planilha de pendências — prioridade de ação.';
    secondaryLabel = 'Situação regular entre matriculados (fora da pendência)';
    secondaryDesc = 'Matriculados que não aparecem na planilha de pendências deste tema.';
    tertiaryLabel = 'Só na outra base (não matriculado aqui)';
    tertiaryDesc = 'Linhas na planilha sem match com nenhum matriculado distinto (RGM/CPF).';
  } else if (b.mode === 'other_is_coverage_list') {
    primaryLabel = 'Matriculados com linha no export Blackboard';
    primaryDesc = 'Match entre matrícula e arquivo de acesso BB.';
    secondaryLabel = 'Matriculados sem linha no export BB';
    secondaryDesc = 'Matriculados sem registro correspondente no arquivo — possível foco de acesso.';
    tertiaryLabel = 'No BB, fora do conjunto de matriculados';
    tertiaryDesc = 'Linhas do BB sem match com matriculados (outro ciclo, etc.).';
  } else {
    primaryLabel = 'Matriculados com processo CAA no arquivo';
    primaryDesc = 'Pelo menos uma linha de processo ligada ao RGM/CPF do matriculado.';
    secondaryLabel = 'Matriculados sem processo no arquivo';
    secondaryDesc = 'Sem linha de processo com o mesmo RGM/CPF neste snapshot.';
    tertiaryLabel = 'Processos sem matrícula correspondente';
    tertiaryDesc = 'Protocolos no arquivo que não casam com matriculados distintos.';
  }

  return (
    <div className="rounded-xl border border-gray-100 bg-white p-4 shadow-sm">
      <h4 className="text-sm font-semibold text-gray-900">{b.title}</h4>
      <p className="text-[11px] text-gray-500 mt-0.5">
        Outra base: {b.other_snapshot?.file_name} · {b.na_outra_rows?.toLocaleString('pt-BR')} linhas ·{' '}
        {b.na_outra_distintos.toLocaleString('pt-BR')} chaves distintas
      </p>
      <dl className="mt-3 space-y-3 text-xs">
        <div className="rounded-lg bg-rose-50 border border-rose-100 px-3 py-2">
          <dt className="text-rose-800 font-medium">{primaryLabel}</dt>
          <dd className="text-lg mt-0.5">
            <Num n={a} />
          </dd>
          <dd className="text-rose-700/90 mt-1 leading-snug">{primaryDesc}</dd>
        </div>
        <div className="rounded-lg bg-emerald-50 border border-emerald-100 px-3 py-2">
          <dt className="text-emerald-800 font-medium">{secondaryLabel}</dt>
          <dd className="text-lg mt-0.5">
            <Num n={bOnly} />
          </dd>
          <dd className="text-emerald-700/90 mt-1 leading-snug">{secondaryDesc}</dd>
        </div>
        <div className="rounded-lg bg-gray-50 border border-gray-100 px-3 py-2">
          <dt className="text-gray-700 font-medium">{tertiaryLabel}</dt>
          <dd className="text-lg mt-0.5">
            <Num n={out} />
          </dd>
          <dd className="text-gray-600 mt-1 leading-snug">{tertiaryDesc}</dd>
        </div>
      </dl>
    </div>
  );
}

interface Props {
  data: MatriculadosComparisonResponse | null;
  loading: boolean;
  error: string | null;
  onRefresh: () => void;
}

export function MatriculadosComparisonPanel({ data, loading, error, onRefresh }: Props) {
  return (
    <section className="bg-white rounded-xl border border-gray-100 shadow-sm overflow-hidden">
      <div className="px-4 py-3 border-b border-gray-100 flex flex-wrap items-center justify-between gap-2 bg-gray-50/80">
        <div>
          <h3 className="text-sm font-semibold text-gray-900">Comparação com base em Matriculados</h3>
          <p className="text-xs text-gray-500 mt-0.5 max-w-3xl">
            Universo: último snapshot de matriculados. Cruzamento por RGM (só dígitos) ou CPF com 11 dígitos.
            Linhas sem RGM/CPF válidos não entram no cruzamento (veja contador “sem chave” na API).
          </p>
        </div>
        <button
          type="button"
          onClick={onRefresh}
          disabled={loading}
          className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-gray-700 bg-white border border-gray-200 rounded-lg hover:bg-gray-50 disabled:opacity-50"
        >
          <RefreshCw className={`w-3.5 h-3.5 ${loading ? 'animate-spin' : ''}`} />
          Recalcular painel
        </button>
      </div>

      <div className="p-4">
        {error && (
          <div className="mb-3 rounded-lg bg-rose-50 border border-rose-200 text-xs text-rose-700 px-3 py-2">
            {error}
          </div>
        )}
        {loading && !data && <p className="text-sm text-gray-500">Carregando comparações…</p>}
        {data && (
          <div className="space-y-4">
            <div className="flex flex-wrap gap-4 text-xs text-gray-600">
              <span>
                Snapshot matrícula:{' '}
                <span className="font-medium text-gray-900">{data.matriculados_snapshot?.file_name}</span>
              </span>
              <span>
                Matriculados distintos (RGM/CPF): <Num n={data.matriculados_distintos} />
              </span>
              {data.matriculados_sem_chave > 0 && (
                <span className="text-amber-700">
                  Linhas matrícula sem chave: <Num n={data.matriculados_sem_chave} />
                </span>
              )}
            </div>
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
              {data.comparisons.map((b) => (
                <BlockCard key={b.id} b={b} />
              ))}
            </div>
          </div>
        )}
      </div>
    </section>
  );
}
