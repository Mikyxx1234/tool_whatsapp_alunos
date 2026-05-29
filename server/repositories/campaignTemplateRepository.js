import { query } from '../db/client.js';

const FIELDS = `
  id, campaign_type_id, canal, fluxo, evento, delay_dias, nome_template,
  template_language, conteudo, variaveis, ativo, created_at, updated_at
`;

export async function findActive({ canal, fluxo, evento }) {
  const { rows } = await query(
    `select ${FIELDS} from campaign_templates
       where ativo = true
         and canal = $1
         and (fluxo is null or fluxo = $2)
         and evento = $3
       order by case when fluxo = $2 then 0 else 1 end
       limit 1`,
    [canal, fluxo, evento]
  );
  return rows[0] || null;
}

/** Lista todos os templates ativos de um fluxo + canal — usado pelo gerador. */
export async function listByFlow({ canal, fluxo }) {
  const { rows } = await query(
    `select ${FIELDS} from campaign_templates
       where ativo = true
         and canal = $1
         and (fluxo is null or fluxo = $2)
       order by delay_dias asc`,
    [canal, fluxo]
  );
  return rows;
}

export async function findById(id) {
  const { rows } = await query(
    `select ${FIELDS} from campaign_templates where id = $1 limit 1`,
    [id]
  );
  return rows[0] || null;
}

export async function listAll({ ativoOnly = true } = {}) {
  const where = ativoOnly ? 'where ativo = true' : '';
  const { rows } = await query(
    `select ${FIELDS} from campaign_templates ${where}
       order by canal, fluxo nulls last, delay_dias`
  );
  return rows;
}
