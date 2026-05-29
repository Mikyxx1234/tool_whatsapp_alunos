import { query } from '../db/client.js';

const FIELDS = `
  id, term_id, scope,
  gap_threshold_a, gap_threshold_b,
  ambientacao_ativa, ambientacao_obrigatoria, ambientacao_dias,
  conteudo_previo_ativo,
  delay_inicio_ativo, delay_inicio_max_dias, delay_inicio_acao,
  liberacao_acesso, liberacao_acesso_dias,
  inativo_dias,
  caa_janela_t0, caa_janela_dias_tipo,
  bb_nao_acessa_dias, bb_acessou_pouco_minutos, bb_acessou_pouco_interacoes,
  raw_config, created_at, updated_at
`;

const ALLOWED = [
  'gap_threshold_a', 'gap_threshold_b',
  'ambientacao_ativa', 'ambientacao_obrigatoria', 'ambientacao_dias',
  'conteudo_previo_ativo',
  'delay_inicio_ativo', 'delay_inicio_max_dias', 'delay_inicio_acao',
  'liberacao_acesso', 'liberacao_acesso_dias',
  'inativo_dias',
  'caa_janela_t0', 'caa_janela_dias_tipo',
  'bb_nao_acessa_dias', 'bb_acessou_pouco_minutos', 'bb_acessou_pouco_interacoes',
];

export async function getGlobal(client) {
  const exec = client ? client.query.bind(client) : query;
  const { rows } = await exec(
    `select ${FIELDS} from journey_settings where scope = 'GLOBAL' limit 1`
  );
  return rows[0] || null;
}

export async function getByTerm(termId, client) {
  if (!termId) return null;
  const exec = client ? client.query.bind(client) : query;
  const { rows } = await exec(
    `select ${FIELDS} from journey_settings where term_id = $1 limit 1`,
    [termId]
  );
  return rows[0] || null;
}

/**
 * Resolve as configurações efetivas para um aluno: se houver linha por turma,
 * usa ela; caso contrário cai no GLOBAL. Sempre retorna algo (insere GLOBAL
 * default se ainda não existe).
 */
export async function resolveForTerm(termId, client) {
  const exec = client ? client.query.bind(client) : query;
  const term = termId ? await getByTerm(termId, client) : null;
  if (term) return term;
  let global = await getGlobal(client);
  if (!global) {
    const { rows } = await exec(
      `insert into journey_settings (scope) values ('GLOBAL') returning ${FIELDS}`
    );
    global = rows[0];
  }
  return global;
}

function pickAllowed(input) {
  const out = {};
  for (const k of ALLOWED) if (input[k] !== undefined) out[k] = input[k];
  return out;
}

export async function upsertGlobal(input) {
  const data = pickAllowed(input);
  const existing = await getGlobal();
  if (existing) {
    const sets = [];
    const params = [existing.id];
    let i = 1;
    for (const [k, v] of Object.entries(data)) {
      i += 1;
      params.push(v);
      sets.push(`${k} = $${i}`);
    }
    if (input.raw_config !== undefined) {
      i += 1;
      params.push(input.raw_config ? JSON.stringify(input.raw_config) : null);
      sets.push(`raw_config = $${i}`);
    }
    if (sets.length === 0) return existing;
    const { rows } = await query(
      `update journey_settings set ${sets.join(', ')} where id = $1 returning ${FIELDS}`,
      params
    );
    return rows[0];
  }
  const cols = ['scope', ...Object.keys(data)];
  const vals = ['GLOBAL', ...Object.values(data)];
  const placeholders = cols.map((_, i) => `$${i + 1}`);
  const { rows } = await query(
    `insert into journey_settings (${cols.join(', ')})
     values (${placeholders.join(', ')})
     returning ${FIELDS}`,
    vals
  );
  return rows[0];
}

export async function upsertForTerm(termId, input) {
  if (!termId) throw new Error('termId é obrigatório');
  const data = pickAllowed(input);
  const existing = await getByTerm(termId);
  if (existing) {
    const sets = [];
    const params = [existing.id];
    let i = 1;
    for (const [k, v] of Object.entries(data)) {
      i += 1;
      params.push(v);
      sets.push(`${k} = $${i}`);
    }
    if (sets.length === 0) return existing;
    const { rows } = await query(
      `update journey_settings set ${sets.join(', ')} where id = $1 returning ${FIELDS}`,
      params
    );
    return rows[0];
  }
  const cols = ['scope', 'term_id', ...Object.keys(data)];
  const vals = ['TERM', termId, ...Object.values(data)];
  const placeholders = cols.map((_, i) => `$${i + 1}`);
  const { rows } = await query(
    `insert into journey_settings (${cols.join(', ')})
     values (${placeholders.join(', ')})
     returning ${FIELDS}`,
    vals
  );
  return rows[0];
}

export async function listAll() {
  const { rows } = await query(`select ${FIELDS} from journey_settings order by scope asc`);
  return rows;
}
