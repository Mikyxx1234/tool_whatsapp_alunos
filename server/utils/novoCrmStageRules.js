/**
 * Regras de etapa/flags Novo CRM (DEV) — matriculados + bases satélite.
 * IDs default = CRM DEV; sobrescreva via env NOVO_CRM_STAGE_* / NOVO_CRM_FIELD_*.
 */

function envId(key, fallback) {
  const v = String(process.env[key] || '').trim();
  return v || fallback;
}

export function getNovoCrmStageIds() {
  return {
    Acolhimento: envId('NOVO_CRM_STAGE_ACOLHIMENTO', 'cmrtilckh001tua48a8n1mi8w'),
    Graduação: envId('NOVO_CRM_STAGE_GRADUACAO', 'cmrtilckh001uua48mv59m7vf'),
    Pós: envId('NOVO_CRM_STAGE_POS', 'cmrtilckh001vua48ozyjlar6'),
    Retenção: envId('NOVO_CRM_STAGE_RETENCAO', 'cmrtilckh001wua48e5t40tyw'),
    'Sem Rematricula': envId('NOVO_CRM_STAGE_SEM_REMATRICULA', 'cmrtilckh001xua48q124whlu'),
    Cancelado: envId('NOVO_CRM_STAGE_CANCELADO', 'cmrtit17i002vua48j28a5mms'),
    Ganho: envId('NOVO_CRM_STAGE_GANHO', 'cmrtilckh001yua48xxic8vwx'),
    Perdido: envId('NOVO_CRM_STAGE_PERDIDO', 'cmrtilckh001zua48bubr5vya'),
  };
}

/** Etapas que o job NÃO move (humano/IA). Flags ainda podem ser atualizadas. */
export function getUntouchableStageIds() {
  const s = getNovoCrmStageIds();
  return new Set([s.Ganho, s.Retenção, s.Cancelado].filter(Boolean));
}

export function isUntouchableStageId(stageId) {
  const id = String(stageId || '').trim();
  if (!id) return false;
  return getUntouchableStageIds().has(id);
}

export function stageNameFromId(stageId) {
  const id = String(stageId || '').trim();
  if (!id) return null;
  const stages = getNovoCrmStageIds();
  for (const [name, sid] of Object.entries(stages)) {
    if (sid === id) return name;
  }
  return null;
}

/** Custom fields deal (DEV). */
export function getNovoCrmDealFieldIds() {
  return {
    cpf: envId('NOVO_CRM_FIELD_CPF', 'cmr9f7nfk02xhp701mhvulyxe'),
    rgm: envId('NOVO_CRM_FIELD_RGM', 'cmr9dvugp02sbp7019lv6jgt4'),
    curso: envId('NOVO_CRM_FIELD_CURSO', 'cmr9dw2bx02sdp701lxbkt4nd'),
    polo: envId('NOVO_CRM_FIELD_POLO', 'cmr9f0ang02whp7016bmxlzji'),
    situacao: envId('NOVO_CRM_FIELD_SITUACAO', 'cmr9f1ewb02wpp701gb7y5rf8'),
    email: envId('NOVO_CRM_FIELD_EMAIL', 'cmr9f27vg02wtp701sry87ds4'),
    email_ad: envId('NOVO_CRM_FIELD_EMAIL_AD', 'cmr9f2iq302wxp701573yz5w7'),
    nasc: envId('NOVO_CRM_FIELD_NASC', 'cmq579tb1003bvemcck96lhwx'),
    acessoblack: envId('NOVO_CRM_FIELD_ACESSO_BLACK', 'cmrtjzsqx008hua48qsgaeppd'),
    doc_pendentes: envId('NOVO_CRM_FIELD_DOC_PENDENTES', 'cmrtjumbj007nua48rqjbzzj8'),
    inadimplente: envId('NOVO_CRM_FIELD_INADIMPLENTE', 'cmrtjygzx008bua48uiugpx9u'),
    evasao: envId('NOVO_CRM_FIELD_EVASAO', 'cmrtk0ob6008nua48ceomws81'),
  };
}

function digits(v) {
  return String(v ?? '').replace(/\D/g, '');
}

function excelSerialToDate(serial) {
  const n = Number(serial);
  if (!Number.isFinite(n) || n < 20000) return null;
  return new Date(Date.UTC(1899, 11, 30) + Math.floor(n) * 86400000);
}

function pick(row, keys) {
  for (const k of keys) {
    const v = row?.[k];
    if (v != null && String(v).trim() !== '') return String(v).trim();
  }
  return '';
}

/**
 * @param {Record<string, unknown>} matRow
 * @param {{
 *   inRematricula: boolean,
 *   inDoc: boolean,
 *   inInad: boolean,
 *   inBb: boolean,
 *   inEvasao: boolean,
 *   now?: Date,
 * }} ctx
 */
export function classifyMatriculado(matRow, ctx) {
  const situacao = pick(matRow, ['Situação Matrícula', 'Situacao Matricula', 'Situação']).toUpperCase();
  const negocio = pick(matRow, ['Negócio', 'Negocio', 'Empresa', 'Nível', 'Nivel'])
    .toUpperCase()
    .normalize('NFD')
    .replace(/\p{M}/gu, '');
  const isCancelado = situacao
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .includes('CANCEL');
  const isPos =
    negocio.includes('POS-GRAD') ||
    negocio.includes('POS GRAD') ||
    /(^|[^A-Z])POS([^A-Z]|$)/.test(negocio);
  const isGrad = negocio.includes('GRAD') && !isPos;

  const dmRaw = pick(matRow, ['Data Matrícula', 'Data Matricula']);
  let dm = excelSerialToDate(dmRaw);
  if (!dm && /^\d{4}-\d{2}-\d{2}/.test(dmRaw)) dm = new Date(`${dmRaw.slice(0, 10)}T00:00:00Z`);
  const now = ctx.now || new Date();
  const nowUtc = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  let inAcolhimento = false;
  let acolhimentoAte = null;
  if (dm) {
    const limit = Date.UTC(dm.getUTCFullYear(), dm.getUTCMonth(), 25);
    acolhimentoAte = new Date(limit).toISOString().slice(0, 10);
    inAcolhimento = nowUtc <= limit;
  }

  const stages = getNovoCrmStageIds();
  /** @type {string} */
  let stageName;
  // RGM cancelado → Perdido (gera estatística). A etapa "Cancelado" é reservada
  // ao time de retenção (manual, até o cancelamento ser deferido) e NÃO é usada aqui.
  if (isCancelado) stageName = 'Perdido';
  else if (ctx.inRematricula) stageName = 'Sem Rematricula';
  else if (inAcolhimento) stageName = 'Acolhimento';
  else if (isPos) stageName = 'Pós';
  else if (isGrad) stageName = 'Graduação';
  else stageName = 'Graduação';

  // Retenção e Cancelado: só manual/IA — nunca atribuídas por este job.
  // Ganho: intocável por este job.

  return {
    stageName,
    stageId: stages[stageName],
    flags: {
      doc_pendentes: Boolean(ctx.inDoc),
      inadimplente: Boolean(ctx.inInad),
      acessoblack: Boolean(ctx.inBb),
      evasao: Boolean(ctx.inEvasao),
    },
    meta: {
      situacao,
      negocio,
      isCancelado,
      isPos,
      isGrad,
      inAcolhimento,
      acolhimentoAte,
      cpf: digits(pick(matRow, ['CPF', 'cpf'])),
      rgm: digits(pick(matRow, ['RGM', 'rgm'])),
    },
  };
}

export function titleCasePolo(raw) {
  let s = String(raw || '').trim();
  if (!s) return '';
  s = s.replace(/^\d+\s*[-–]\s*/u, '');
  s = s.replace(/\b(CEB\s+)?POLO\s+/giu, '');
  s = s.replace(/\bSP_/giu, '');
  s = s.replace(/_+/g, ' ').replace(/\s+/g, ' ').trim();
  return s
    .toLowerCase()
    .split(' ')
    .map((w) => (w.length <= 2 ? w.toUpperCase() : w.charAt(0).toUpperCase() + w.slice(1)))
    .join(' ');
}

export function phoneE164Br(raw) {
  let d = digits(raw);
  if (!d) return null;
  if (d.startsWith('55') && d.length >= 12) return `+${d}`;
  if (d.length >= 10 && d.length <= 11) return `+55${d}`;
  return d.startsWith('+') ? raw : `+${d}`;
}
