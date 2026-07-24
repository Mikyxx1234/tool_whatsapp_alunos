/**
 * Mapeamento matriculados → custom fields do deal no Novo CRM (EduIT).
 * Só preenche quando o campo no CRM está vazio.
 */

export const MAPPED_DEAL_FIELD_NAMES = Object.freeze([
  'cpf',
  'rgm',
  'situacao',
  'polo',
  'nivel',
  'ciclo',
  'primeiro_nome',
  'curso',
  'telefone_comercial',
  'e_mail_ad',
]);

/**
 * @param {Record<string, unknown>|null|undefined} row
 * @param {string[]} keys
 */
function pick(row, keys) {
  if (!row) return '';
  for (const k of keys) {
    const v = row[k];
    if (v != null && String(v).trim() !== '') return String(v).trim();
  }
  return '';
}

export function normalizeSituacaoCrm(raw) {
  const s = String(raw || '')
    .trim()
    .toUpperCase()
    .normalize('NFD')
    .replace(/\p{M}/gu, '');
  if (!s) return '';
  if (s.includes('CURSO')) return 'Em Curso';
  if (s.includes('CANCEL')) return 'Cancelado';
  if (s.includes('TRANC')) return 'Trancado';
  if (s.includes('TRANSFER')) return 'Transferido';
  return String(raw).trim();
}

export function normalizeCicloCrm(raw) {
  const s = String(raw || '').trim();
  if (!s) return '';
  return s.replace(/\//g, '.');
}

/** Limpeza leve de polo SIAA → texto mais próximo das opções do CRM. */
export function normalizePoloCrm(raw) {
  let s = String(raw || '').trim();
  if (!s) return '';
  s = s.replace(/^\d+\s*[-–]\s*/u, '');
  s = s.replace(/\b(CEB\s+)?POLO\s+/giu, '');
  s = s.replace(/\bSP_/giu, '');
  s = s.replace(/_+/g, ' ').replace(/\s+/g, ' ').trim();
  if (!s) return '';
  return s
    .toLowerCase()
    .split(' ')
    .map((w) => (w.length <= 2 ? w.toUpperCase() : w.charAt(0).toUpperCase() + w.slice(1)))
    .join(' ');
}

/**
 * SIAA Negócio → opções SELECT do CRM ("Graduação" | "Pós-Graduação").
 * POS antes de GRAD (senão "PÓS-GRADUAÇÃO" virava Graduação).
 * COLÉGIO / Técnico / Extensão / vazio → '' (não envia opção inválida).
 */
export function normalizeNivelCrm(raw) {
  const s = String(raw || '').trim();
  if (!s) return '';
  const u = s
    .toUpperCase()
    .normalize('NFD')
    .replace(/\p{M}/gu, '');
  const isPos =
    u.includes('POS-GRAD') ||
    u.includes('POS GRAD') ||
    /(^|[^A-Z])POS([^A-Z]|$)/.test(u);
  if (isPos) return 'Pós-Graduação';
  if (u.includes('GRAD')) return 'Graduação';
  return '';
}

/**
 * Extrai valores canônicos do relatório de matriculados.
 * @param {Record<string, unknown>} row
 */
export function extractMatriculadosMappedValues(row) {
  const nomeFull = pick(row, ['Nome', 'NOME', 'Aluno', 'Nome Aluno']);
  const primeiro =
    nomeFull.split(/\s+/).filter(Boolean)[0] || nomeFull;

  const foneCel = pick(row, ['Fone celular', 'Celular', 'Telefone']);
  const foneCom = pick(row, ['Fone Comercial', 'Fone comercial']);

  return {
    cpf: pick(row, ['CPF']),
    rgm: pick(row, ['RGM', 'RGM_ALUN']),
    situacao: normalizeSituacaoCrm(
      pick(row, ['Situação Matrícula', 'Situacao Matricula', 'Situação', 'Situa'])
    ),
    polo: normalizePoloCrm(pick(row, ['Polo', 'NOME_POL'])),
    nivel: normalizeNivelCrm(
      // SIAA matriculados usa "Negócio" (GRADUAÇÃO / PÓS-GRADUAÇÃO); Nível é fallback.
      pick(row, ['Negócio', 'Negocio', 'Nível', 'Nivel', 'Nível de Ensino', 'Empresa', 'Instituição'])
    ),
    ciclo: normalizeCicloCrm(pick(row, ['Ciclo'])),
    primeiro_nome: primeiro,
    curso: pick(row, ['Curso', 'DES_CURS']),
    telefone_comercial: foneCel || foneCom,
    e_mail_ad: pick(row, ['Email acadêmico', 'Email academico', 'Email Acadêmico', 'Email acad']),
    /** extras para match / contact nativo */
    _nome_full: nomeFull,
    _email: pick(row, ['Email', 'E-mail']),
    _phone: foneCel || foneCom,
  };
}

/**
 * Lê custom fields do primary deal no raw_data do cache.
 * @param {object} rawData
 * @returns {Record<string, string>}
 */
export function dealCustomFieldMapFromRaw(rawData) {
  /** @type {Record<string, string>} */
  const out = {};
  if (!rawData || typeof rawData !== 'object') return out;
  const primaryId = rawData.primaryDealId ? String(rawData.primaryDealId) : null;
  const dealsById = rawData.dealsById && typeof rawData.dealsById === 'object' ? rawData.dealsById : {};
  const ordered = [];
  if (primaryId && dealsById[primaryId]) ordered.push(dealsById[primaryId]);
  for (const [id, deal] of Object.entries(dealsById)) {
    if (id === primaryId) continue;
    ordered.push(deal);
  }
  for (const deal of ordered) {
    for (const f of deal?.customFields || []) {
      const name = String(f?.name || '')
        .trim()
        .toLowerCase();
      if (!name || out[name] != null) continue;
      const val = f?.value;
      if (val == null || String(val).trim() === '') {
        out[name] = '';
      } else {
        out[name] = String(val).trim();
      }
    }
  }
  return out;
}

/**
 * @param {object} cacheRow — row do novo_crm_person_cache
 * @returns {boolean}
 */
export function cacheRowHasIncompleteMappedFields(cacheRow) {
  const fields = dealCustomFieldMapFromRaw(cacheRow?.raw_data || cacheRow?.rawData || {});
  for (const name of MAPPED_DEAL_FIELD_NAMES) {
    const v = fields[name];
    if (v == null || String(v).trim() === '') {
      // fallback denorm
      if (name === 'cpf' && cacheRow?.cpf_norm) continue;
      if (name === 'rgm' && cacheRow?.rgm_norm) continue;
      if (name === 'telefone_comercial' && cacheRow?.phone_norm) continue;
      if (name === 'primeiro_nome' && cacheRow?.nome) continue;
      if (name === 'e_mail_ad' && cacheRow?.email_norm) continue;
      return true;
    }
  }
  return false;
}

/**
 * Campos do scope que devem ser considerados no enrich.
 * @param {'cpf'|'rgm'|'incomplete'|'all_mapped'} scope
 */
export function fieldNamesForScope(scope) {
  if (scope === 'cpf') return ['cpf'];
  if (scope === 'rgm') return ['rgm'];
  return [...MAPPED_DEAL_FIELD_NAMES];
}
