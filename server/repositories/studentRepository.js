import { query, withTransaction } from '../db/client.js';
import { toIsoDate } from '../utils/dateParser.js';
import { normalizeBrazilianPhone } from '../utils/phoneNormalizer.js';

export const FIELDS = `
  id, nome, telefone, telefone_normalizado, email, cpf, curso, polo, origem,
  data_matricula, data_inicio_conteudo, data_acesso_liberado, ultimo_acesso,
  gap_dias, fluxo, status, engagement_score, raw_data,
  term_id, rgm, ciclo, tipo_matricula, instituicao, empresa,
  override_data_inicio_conteudo, override_data_acesso_liberado,
  ultimo_acesso_blackboard, minutos_acesso, total_interacoes, total_registros,
  fonte_dados,
  created_at, updated_at
`;

function normalizeInput(input) {
  const phoneRaw = input.telefone || input.phone || '';
  const phoneNorm = phoneRaw
    ? normalizeBrazilianPhone(phoneRaw)
    : { ok: false, phone: '' };
  return {
    nome: (input.nome || input.name || '').trim() || null,
    telefone: phoneRaw || null,
    telefone_normalizado: phoneNorm.ok ? phoneNorm.phone : (input.telefone_normalizado || null),
    email: (input.email || '').trim().toLowerCase() || null,
    cpf: (input.cpf || '').replace(/\D+/g, '') || null,
    curso: input.curso || null,
    polo: input.polo || null,
    origem: input.origem || null,
    data_matricula: toIsoDate(input.data_matricula),
    data_inicio_conteudo: toIsoDate(input.data_inicio_conteudo),
    data_acesso_liberado: toIsoDate(input.data_acesso_liberado),
    ultimo_acesso: input.ultimo_acesso || null,
    raw_data: input.raw_data || input.rawData || null,
    term_id: input.term_id || input.termId || null,
    rgm: (input.rgm || '').toString().trim() || null,
    ciclo: input.ciclo || null,
    tipo_matricula: input.tipo_matricula || input.tipoMatricula || null,
    instituicao: input.instituicao || null,
    empresa: input.empresa || null,
    override_data_inicio_conteudo: toIsoDate(input.override_data_inicio_conteudo),
    override_data_acesso_liberado: toIsoDate(input.override_data_acesso_liberado),
    ultimo_acesso_blackboard: input.ultimo_acesso_blackboard || null,
    minutos_acesso:
      input.minutos_acesso === undefined || input.minutos_acesso === null
        ? null
        : Number(input.minutos_acesso),
    total_interacoes:
      input.total_interacoes === undefined || input.total_interacoes === null
        ? null
        : Number(input.total_interacoes),
    total_registros:
      input.total_registros === undefined || input.total_registros === null
        ? null
        : Number(input.total_registros),
    fonte_dados: input.fonte_dados || null,
  };
}

/**
 * Insere ou atualiza um aluno. Chave de idempotência (em ordem):
 *   1) rgm                    (mais forte — vem do Blackboard)
 *   2) cpf
 *   3) email
 *   4) telefone_normalizado   (fallback)
 *
 * Retorna o aluno final (com id) e um flag indicando se foi insert ou update.
 */
export async function upsertByKey(input, client) {
  const data = normalizeInput(input);
  if (!data.nome) {
    throw new Error('nome é obrigatório para criar aluno.');
  }

  const exec = client ? client.query.bind(client) : query;

  let existing = null;
  if (data.rgm) {
    const { rows } = await exec(
      `select ${FIELDS} from students where rgm = $1 limit 1`,
      [data.rgm]
    );
    existing = rows[0] || null;
  }
  if (!existing && data.cpf) {
    const { rows } = await exec(
      `select ${FIELDS} from students where cpf = $1 limit 1`,
      [data.cpf]
    );
    existing = rows[0] || null;
  }
  if (!existing && data.email) {
    const { rows } = await exec(
      `select ${FIELDS} from students where email = $1 limit 1`,
      [data.email]
    );
    existing = rows[0] || null;
  }
  if (!existing && data.telefone_normalizado) {
    const { rows } = await exec(
      `select ${FIELDS} from students where telefone_normalizado = $1 limit 1`,
      [data.telefone_normalizado]
    );
    existing = rows[0] || null;
  }

  if (existing) {
    const { rows } = await exec(
      `update students set
         nome = coalesce($2, nome),
         telefone = coalesce($3, telefone),
         telefone_normalizado = coalesce($4, telefone_normalizado),
         email = coalesce($5, email),
         cpf = coalesce($6, cpf),
         curso = coalesce($7, curso),
         polo = coalesce($8, polo),
         origem = coalesce($9, origem),
         data_matricula = coalesce($10, data_matricula),
         data_inicio_conteudo = coalesce($11, data_inicio_conteudo),
         data_acesso_liberado = coalesce($12, data_acesso_liberado),
         ultimo_acesso = coalesce($13, ultimo_acesso),
         raw_data = coalesce($14, raw_data),
         term_id = coalesce($15, term_id),
         rgm = coalesce($16, rgm),
         ciclo = coalesce($17, ciclo),
         tipo_matricula = coalesce($18, tipo_matricula),
         instituicao = coalesce($19, instituicao),
         empresa = coalesce($20, empresa),
         override_data_inicio_conteudo = coalesce($21, override_data_inicio_conteudo),
         override_data_acesso_liberado = coalesce($22, override_data_acesso_liberado),
         ultimo_acesso_blackboard = coalesce($23, ultimo_acesso_blackboard),
         minutos_acesso = coalesce($24, minutos_acesso),
         total_interacoes = coalesce($25, total_interacoes),
         total_registros = coalesce($26, total_registros),
         fonte_dados = coalesce($27, fonte_dados)
       where id = $1
       returning ${FIELDS}`,
      [
        existing.id,
        data.nome,
        data.telefone,
        data.telefone_normalizado,
        data.email,
        data.cpf,
        data.curso,
        data.polo,
        data.origem,
        data.data_matricula,
        data.data_inicio_conteudo,
        data.data_acesso_liberado,
        data.ultimo_acesso,
        data.raw_data ? JSON.stringify(data.raw_data) : null,
        data.term_id,
        data.rgm,
        data.ciclo,
        data.tipo_matricula,
        data.instituicao,
        data.empresa,
        data.override_data_inicio_conteudo,
        data.override_data_acesso_liberado,
        data.ultimo_acesso_blackboard,
        data.minutos_acesso,
        data.total_interacoes,
        data.total_registros,
        data.fonte_dados,
      ]
    );
    return { student: rows[0], created: false };
  }

  const { rows } = await exec(
    `insert into students
       (nome, telefone, telefone_normalizado, email, cpf, curso, polo, origem,
        data_matricula, data_inicio_conteudo, data_acesso_liberado, ultimo_acesso, raw_data,
        term_id, rgm, ciclo, tipo_matricula, instituicao, empresa,
        override_data_inicio_conteudo, override_data_acesso_liberado,
        ultimo_acesso_blackboard, minutos_acesso, total_interacoes, total_registros, fonte_dados)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,
             $14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26)
     returning ${FIELDS}`,
    [
      data.nome,
      data.telefone,
      data.telefone_normalizado,
      data.email,
      data.cpf,
      data.curso,
      data.polo,
      data.origem,
      data.data_matricula,
      data.data_inicio_conteudo,
      data.data_acesso_liberado,
      data.ultimo_acesso,
      data.raw_data ? JSON.stringify(data.raw_data) : null,
      data.term_id,
      data.rgm,
      data.ciclo,
      data.tipo_matricula,
      data.instituicao,
      data.empresa,
      data.override_data_inicio_conteudo,
      data.override_data_acesso_liberado,
      data.ultimo_acesso_blackboard,
      data.minutos_acesso,
      data.total_interacoes,
      data.total_registros,
      data.fonte_dados,
    ]
  );
  return { student: rows[0], created: true };
}

export async function bulkUpsert(inputs) {
  if (!Array.isArray(inputs) || inputs.length === 0) {
    return { students: [], created: 0, updated: 0, errors: [] };
  }
  return withTransaction(async (client) => {
    const students = [];
    const errors = [];
    let created = 0;
    let updated = 0;
    for (let i = 0; i < inputs.length; i += 1) {
      try {
        const r = await upsertByKey(inputs[i], client);
        students.push(r.student);
        if (r.created) created += 1;
        else updated += 1;
      } catch (err) {
        errors.push({ index: i, error: err.message, input: inputs[i] });
      }
    }
    return { students, created, updated, errors };
  });
}

export async function findById(id, client) {
  const exec = client ? client.query.bind(client) : query;
  const { rows } = await exec(
    `select ${FIELDS} from students where id = $1 limit 1`,
    [id]
  );
  return rows[0] || null;
}

export async function findByPhone(normalizedPhone, client) {
  const exec = client ? client.query.bind(client) : query;
  if (!normalizedPhone) return null;
  const { rows } = await exec(
    `select ${FIELDS} from students where telefone_normalizado = $1 limit 1`,
    [normalizedPhone]
  );
  return rows[0] || null;
}

export async function findByRgm(rgm, client) {
  const exec = client ? client.query.bind(client) : query;
  if (!rgm) return null;
  const { rows } = await exec(
    `select ${FIELDS} from students where rgm = $1 limit 1`,
    [String(rgm).trim()]
  );
  return rows[0] || null;
}

export async function findByEmail(email, client) {
  const exec = client ? client.query.bind(client) : query;
  if (!email) return null;
  const { rows } = await exec(
    `select ${FIELDS} from students where email = $1 limit 1`,
    [String(email).trim().toLowerCase()]
  );
  return rows[0] || null;
}

/**
 * Carrega aluno + turma + settings num único shape, pronto pra ser usado pelo
 * decisionEngine. Pode ser termId/global override ou null em qualquer parte.
 */
export async function findWithTermAndSettings(studentId, client) {
  const exec = client ? client.query.bind(client) : query;
  const { rows } = await exec(
    `select
       s.*,
       t.id   as term_pk,
       t.codigo                   as term_codigo,
       t.nome                     as term_nome,
       t.inicio_conteudo          as term_inicio_conteudo,
       t.fim_conteudo             as term_fim_conteudo,
       t.tem_ambientacao          as term_tem_ambientacao,
       t.dias_ambientacao         as term_dias_ambientacao,
       t.conteudo_previo_liberado as term_conteudo_previo,
       t.permitir_atraso          as term_permitir_atraso,
       t.dias_atraso_max          as term_dias_atraso_max,
       t.tipo_inicio              as term_tipo_inicio,
       t.liberacao_acesso         as term_liberacao_acesso,
       t.liberacao_acesso_dias    as term_liberacao_acesso_dias,
       js.id   as settings_id,
       js.gap_threshold_a, js.gap_threshold_b,
       js.ambientacao_ativa, js.ambientacao_obrigatoria, js.ambientacao_dias,
       js.conteudo_previo_ativo,
       js.delay_inicio_ativo, js.delay_inicio_max_dias, js.delay_inicio_acao,
       js.liberacao_acesso     as settings_liberacao_acesso,
       js.liberacao_acesso_dias as settings_liberacao_acesso_dias,
       js.inativo_dias,
       js.raw_config
     from students s
     left join academic_terms t on t.id = s.term_id
     left join lateral (
       select * from journey_settings
        where (term_id = s.term_id and s.term_id is not null)
           or (scope = 'GLOBAL' and not exists (
                 select 1 from journey_settings j2
                  where j2.term_id = s.term_id and s.term_id is not null
              ))
        order by case when term_id = s.term_id then 0 else 1 end
        limit 1
     ) js on true
     where s.id = $1
     limit 1`,
    [studentId]
  );
  return rows[0] || null;
}

export async function list({ fluxo, status, search, term_id, polo, limit = 100, offset = 0 } = {}) {
  const conditions = [];
  const params = [];
  if (fluxo) {
    params.push(fluxo);
    conditions.push(`fluxo = $${params.length}`);
  }
  if (status) {
    params.push(status);
    conditions.push(`status = $${params.length}`);
  }
  if (search) {
    params.push(`%${search}%`);
    const idx = params.length;
    conditions.push(
      `(nome ilike $${idx} or email ilike $${idx} or telefone_normalizado ilike $${idx} or cpf ilike $${idx} or rgm ilike $${idx})`
    );
  }
  if (term_id) {
    params.push(term_id);
    conditions.push(`term_id = $${params.length}`);
  }
  if (polo) {
    params.push(`%${polo}%`);
    conditions.push(`polo ilike $${params.length}`);
  }
  const where = conditions.length ? `where ${conditions.join(' and ')}` : '';
  params.push(limit);
  params.push(offset);
  const { rows } = await query(
    `select ${FIELDS} from students ${where}
       order by created_at desc
       limit $${params.length - 1} offset $${params.length}`,
    params
  );
  return rows;
}

export async function listIdsByTerm(termId, client) {
  const exec = client ? client.query.bind(client) : query;
  const { rows } = await exec(
    `select id from students where term_id = $1`,
    [termId]
  );
  return rows.map((r) => r.id);
}

/**
 * Atualização parcial pelo id, permitindo qualquer subconjunto de campos
 * existentes em FIELDS. Usado por overrides individuais.
 */
const UPDATABLE = new Set([
  'nome', 'telefone', 'telefone_normalizado', 'email', 'cpf', 'curso', 'polo',
  'origem', 'data_matricula', 'data_inicio_conteudo', 'data_acesso_liberado',
  'ultimo_acesso', 'term_id', 'rgm', 'ciclo', 'tipo_matricula', 'instituicao',
  'empresa', 'override_data_inicio_conteudo', 'override_data_acesso_liberado',
  'ultimo_acesso_blackboard', 'minutos_acesso', 'total_interacoes',
  'total_registros', 'fonte_dados', 'status',
]);
export async function patchStudent(id, partial, client) {
  const exec = client ? client.query.bind(client) : query;
  const sets = [];
  const params = [id];
  let i = 1;
  for (const [k, v] of Object.entries(partial || {})) {
    if (!UPDATABLE.has(k)) continue;
    i += 1;
    params.push(v);
    sets.push(`${k} = $${i}`);
  }
  if (sets.length === 0) return findById(id, client);
  const { rows } = await exec(
    `update students set ${sets.join(', ')} where id = $1 returning ${FIELDS}`,
    params
  );
  return rows[0] || null;
}

export async function updateJourneyFields(studentId, { gap_dias, fluxo }, client) {
  const exec = client ? client.query.bind(client) : query;
  const { rows } = await exec(
    `update students set gap_dias = $2, fluxo = $3 where id = $1 returning ${FIELDS}`,
    [studentId, gap_dias, fluxo]
  );
  return rows[0] || null;
}

export async function updateStatus(studentId, status, extras = {}, client) {
  const exec = client ? client.query.bind(client) : query;
  const setParts = ['status = $2'];
  const params = [studentId, status];
  for (const [key, value] of Object.entries(extras)) {
    params.push(value);
    setParts.push(`${key} = $${params.length}`);
  }
  const { rows } = await exec(
    `update students set ${setParts.join(', ')} where id = $1 returning ${FIELDS}`,
    params
  );
  return rows[0] || null;
}

export async function adjustEngagementScore(studentId, delta, client) {
  const exec = client ? client.query.bind(client) : query;
  const { rows } = await exec(
    `update students set engagement_score = engagement_score + $2
       where id = $1 returning ${FIELDS}`,
    [studentId, delta]
  );
  return rows[0] || null;
}
