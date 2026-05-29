import { query } from '../db/client.js';
import { toIsoDate } from '../utils/dateParser.js';

const FIELDS = `
  id, codigo, nome, descricao,
  nivel, ciclo,
  inicio_matricula, fim_matricula,
  inicio_conteudo, fim_conteudo,
  tem_ambientacao, dias_ambientacao,
  conteudo_previo_liberado,
  permitir_atraso, dias_atraso_max,
  tipo_inicio,
  liberacao_acesso, liberacao_acesso_dias,
  metadata, ativo,
  created_at, updated_at
`;

function normalize(input) {
  return {
    codigo: (input.codigo || '').trim(),
    nome: (input.nome || '').trim(),
    descricao: input.descricao || null,
    nivel: input.nivel || null,
    ciclo: input.ciclo || null,
    inicio_matricula: toIsoDate(input.inicio_matricula),
    fim_matricula: toIsoDate(input.fim_matricula),
    inicio_conteudo: toIsoDate(input.inicio_conteudo),
    fim_conteudo: toIsoDate(input.fim_conteudo),
    tem_ambientacao: Boolean(input.tem_ambientacao),
    dias_ambientacao: Number(input.dias_ambientacao) || 0,
    conteudo_previo_liberado: Boolean(input.conteudo_previo_liberado),
    permitir_atraso: Boolean(input.permitir_atraso),
    dias_atraso_max: Number(input.dias_atraso_max) || 0,
    tipo_inicio: input.tipo_inicio || 'data_fixa',
    liberacao_acesso: input.liberacao_acesso || 'imediato',
    liberacao_acesso_dias: Number(input.liberacao_acesso_dias) || 0,
    metadata: input.metadata || null,
    ativo: input.ativo === undefined ? true : Boolean(input.ativo),
  };
}

export async function create(input) {
  const d = normalize(input);
  if (!d.codigo) throw new Error('codigo da turma é obrigatório.');
  if (!d.nome) throw new Error('nome da turma é obrigatório.');
  const { rows } = await query(
    `insert into academic_terms
       (codigo, nome, descricao,
        nivel, ciclo,
        inicio_matricula, fim_matricula,
        inicio_conteudo, fim_conteudo,
        tem_ambientacao, dias_ambientacao,
        conteudo_previo_liberado,
        permitir_atraso, dias_atraso_max,
        tipo_inicio,
        liberacao_acesso, liberacao_acesso_dias,
        metadata, ativo)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19)
     returning ${FIELDS}`,
    [
      d.codigo, d.nome, d.descricao,
      d.nivel, d.ciclo,
      d.inicio_matricula, d.fim_matricula,
      d.inicio_conteudo, d.fim_conteudo,
      d.tem_ambientacao, d.dias_ambientacao,
      d.conteudo_previo_liberado,
      d.permitir_atraso, d.dias_atraso_max,
      d.tipo_inicio,
      d.liberacao_acesso, d.liberacao_acesso_dias,
      d.metadata ? JSON.stringify(d.metadata) : null, d.ativo,
    ]
  );
  return rows[0];
}

export async function update(id, input) {
  const d = normalize(input);
  const { rows } = await query(
    `update academic_terms set
        codigo = $2, nome = $3, descricao = $4,
        nivel = $5, ciclo = $6,
        inicio_matricula = $7, fim_matricula = $8,
        inicio_conteudo = $9, fim_conteudo = $10,
        tem_ambientacao = $11, dias_ambientacao = $12,
        conteudo_previo_liberado = $13,
        permitir_atraso = $14, dias_atraso_max = $15,
        tipo_inicio = $16,
        liberacao_acesso = $17, liberacao_acesso_dias = $18,
        metadata = $19, ativo = $20
      where id = $1
      returning ${FIELDS}`,
    [
      id,
      d.codigo, d.nome, d.descricao,
      d.nivel, d.ciclo,
      d.inicio_matricula, d.fim_matricula,
      d.inicio_conteudo, d.fim_conteudo,
      d.tem_ambientacao, d.dias_ambientacao,
      d.conteudo_previo_liberado,
      d.permitir_atraso, d.dias_atraso_max,
      d.tipo_inicio,
      d.liberacao_acesso, d.liberacao_acesso_dias,
      d.metadata ? JSON.stringify(d.metadata) : null, d.ativo,
    ]
  );
  return rows[0] || null;
}

export async function findById(id, client) {
  const exec = client ? client.query.bind(client) : query;
  const { rows } = await exec(
    `select ${FIELDS} from academic_terms where id = $1 limit 1`,
    [id]
  );
  return rows[0] || null;
}

export async function findByCodigo(codigo, client) {
  const exec = client ? client.query.bind(client) : query;
  const { rows } = await exec(
    `select ${FIELDS} from academic_terms where codigo = $1 limit 1`,
    [codigo]
  );
  return rows[0] || null;
}

export async function upsertByCodigo(input) {
  const existing = await findByCodigo((input.codigo || '').trim());
  if (existing) {
    return update(existing.id, { ...existing, ...input });
  }
  return create(input);
}

export async function list({ ativoOnly = false, search, nivel, ciclo } = {}) {
  const where = [];
  const params = [];
  if (ativoOnly) where.push('ativo = true');
  if (search) {
    params.push(`%${search}%`);
    where.push(`(codigo ilike $${params.length} or nome ilike $${params.length})`);
  }
  if (nivel) {
    params.push(nivel);
    where.push(`nivel = $${params.length}`);
  }
  if (ciclo) {
    params.push(ciclo);
    where.push(`ciclo = $${params.length}`);
  }
  const sql = `select ${FIELDS} from academic_terms ${
    where.length ? 'where ' + where.join(' and ') : ''
  } order by codigo desc`;
  const { rows } = await query(sql, params);
  return rows;
}

export async function remove(id) {
  const { rowCount } = await query(`delete from academic_terms where id = $1`, [id]);
  return rowCount > 0;
}

export async function countStudentsByTerm() {
  const { rows } = await query(
    `select term_id, count(*)::int as total
       from students
      where term_id is not null
      group by term_id`
  );
  return rows;
}
