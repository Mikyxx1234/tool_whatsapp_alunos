import { query } from '../db/client.js';

/**
 * @param {object} row
 * @param {string} row.category
 * @param {string|null} [row.origemValue]
 * @param {string} row.datacrazyLeadId
 * @param {string} [row.masterKey]
 * @param {string} [row.cpf]
 * @param {string} [row.rgm]
 * @param {string} [row.nome]
 * @param {'ok'|'failed'|'skipped'} row.status
 * @param {string} [row.errorMessage]
 */
export async function recordOrigemAtivacaoLog(row) {
  await query(
    `insert into activation_origem_ativacao_log (
      category, origem_value, datacrazy_lead_id, master_key,
      cpf, rgm, nome, status, error_message
    ) values ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
    [
      row.category,
      row.origemValue ?? '',
      row.datacrazyLeadId,
      row.masterKey ?? null,
      row.cpf ?? null,
      row.rgm ?? null,
      row.nome ?? null,
      row.status,
      row.errorMessage ?? null,
    ]
  );
}
