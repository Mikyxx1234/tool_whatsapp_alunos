/** Perfis do Painel Geral — cada um filtra stats por categoria/base. */

export const PAINEL_PERFIS = [
  { id: 'caa', label: 'Processos CAA', category: 'processos-caa', modo: 'caa' },
  { id: 'financeiro', label: 'Financeiro', category: 'financeiro', modo: 'operacional' },
  { id: 'rematricula', label: 'Rematrícula', category: 'rematricula', modo: 'operacional' },
  { id: 'docs-pendentes', label: 'Docs Pendentes', category: 'docs-pendentes', modo: 'operacional' },
  { id: 'acessos-blackboard', label: 'Acessos Blackboard', category: 'acessos-blackboard', modo: 'operacional' },
  { id: 'provavel-evasao', label: 'Provável Evasão', category: 'provavel-evasao', modo: 'operacional' },
];

const BY_ID = new Map(PAINEL_PERFIS.map((p) => [p.id, p]));

/** @param {string|null|undefined} raw */
export function resolvePainelPerfil(raw) {
  const id = String(raw || 'caa').trim().toLowerCase();
  return BY_ID.get(id) || BY_ID.get('caa');
}
