/**
 * Meu Painel — fonte Novo CRM (tabulação Retido? + ativações/respostas).
 */
import { query } from '../db/client.js';
import { isNovoCrmDbConfigured } from '../db/novoCrmClient.js';
import * as closeTabRepo from '../repositories/conversationCloseTabulationsRepository.js';
import * as legacyRepo from '../repositories/meuPainelLegacyRepository.js';
import { retentionToLegacyOutcome } from '../utils/novoCrmRetencao.js';

const CRM_BASE =
  String(process.env.NOVO_CRM_API_BASE_URL || 'https://crm.eduit.com.br').replace(/\/+$/, '');

/**
 * Contatos ativados via tag no período (log local).
 * @param {{ category?: string|null, from?: string|null, to?: string|null }} opts
 */
async function listActivatedContacts(opts = {}) {
  const params = [];
  const where = [`l.status = 'ok'`, `l.tag_value <> ''`];
  if (opts.category) {
    params.push(opts.category);
    where.push(`l.category = $${params.length}`);
  }
  if (opts.from) {
    params.push(opts.from);
    where.push(`l.created_at >= $${params.length}::date`);
  }
  if (opts.to) {
    params.push(opts.to);
    where.push(`l.created_at < ($${params.length}::date + interval '1 day')`);
  }

  const { rows } = await query(
    `select distinct on (l.contact_id)
       l.contact_id, l.deal_id, l.category, l.master_key, l.cpf, l.rgm, l.nome, l.created_at
     from activation_novo_crm_tag_log l
     where ${where.join(' and ')}
     order by l.contact_id, l.created_at desc`,
    params
  );

  return rows.map((r) => ({
    contactId: String(r.contact_id),
    dealId: r.deal_id || null,
    category: r.category || null,
    masterKey: r.master_key || null,
    cpf: r.cpf || null,
    rgm: r.rgm || null,
    nome: r.nome || null,
    activatedAt: r.created_at ? new Date(r.created_at).toISOString() : null,
  }));
}

function matchesConsultor(name, consultor) {
  if (!consultor || consultor === '*') return true;
  if (!name) return false;
  const a = String(name).toLowerCase();
  const b = String(consultor).toLowerCase();
  return a.includes(b) || b.includes(a);
}

function matchesSearch(item, search) {
  if (!search) return true;
  const q = String(search).toLowerCase();
  const blob = [
    item.nome,
    item.rgm,
    item.cpf,
    item.telefone,
    item.curso,
    item.polo,
    item.master_key,
    item.consultor_responsavel_nome,
    item.contact_id,
    item.deal_id,
    item.deal_number,
    item.deal_title,
    item.tabulation_closed_by_nome,
    item.tabulation_closed_by_email,
    item.tabulation_id,
    item.tabulation_stage_name,
  ]
    .filter(Boolean)
    .join(' ')
    .toLowerCase();
  return blob.includes(q);
}

function sortKey(item) {
  return (
    item.outcome_occurred_at ||
    item.received_at ||
    item.activated_at ||
    ''
  );
}

/**
 * @param {object} filters
 */
export async function listMeuPainelNovoCrm(filters = {}) {
  if (!isNovoCrmDbConfigured()) {
    const err = new Error(
      'Novo CRM DB não configurado. Defina NOVO_CRM_ENABLED=1 e NOVO_CRM_DATABASE_URL.'
    );
    err.status = 503;
    throw err;
  }

  const category = filters.category || null;
  const from = filters.from || null;
  const to = filters.to || null;
  const consultor = filters.consultor || null;
  const search = filters.search || null;
  const limit = Math.min(Math.max(Number(filters.limit) || 100, 1), 300);
  const offset = Math.max(Number(filters.offset) || 0, 0);

  const [activated, replies, tabContactIds, legacyRows] = await Promise.all([
    listActivatedContacts({ category, from, to }),
    closeTabRepo.listCampaignReplyContactIds({ from, to }),
    closeTabRepo.listRetencaoContactIdsInPeriod({ from, to }),
    legacyRepo.listLegacyMeuPainel({ category, from, to, consultor, search }),
  ]);

  /** @type {Map<string, object>} */
  const byContact = new Map();

  for (const a of activated) {
    byContact.set(a.contactId, {
      contact_id: a.contactId,
      deal_id: a.dealId,
      category: a.category || category || 'processos-caa',
      master_key: a.masterKey,
      rgm: a.rgm,
      cpf: a.cpf,
      nome: a.nome,
      activated_at: a.activatedAt,
      received_at: a.activatedAt,
      source: 'novo_crm',
    });
  }

  for (const r of replies) {
    const prev = byContact.get(r.contactId) || {
      contact_id: r.contactId,
      category: category || 'processos-caa',
      source: 'novo_crm',
    };
    prev.received_at = r.repliedAt || prev.received_at;
    prev.replied_at = r.repliedAt;
    byContact.set(r.contactId, prev);
  }

  for (const cid of tabContactIds) {
    if (!byContact.has(cid)) {
      byContact.set(cid, {
        contact_id: cid,
        category: category || 'processos-caa',
        source: 'novo_crm',
      });
    }
  }

  if (category) {
    const activatedSet = new Set(activated.map((a) => a.contactId));
    const tabSet = new Set(tabContactIds);
    for (const cid of [...byContact.keys()]) {
      if (!activatedSet.has(cid) && !tabSet.has(cid)) {
        byContact.delete(cid);
      } else {
        const row = byContact.get(cid);
        if (row) row.category = category;
      }
    }
  }

  const contactIds = [...byContact.keys()];
  const tabulations = contactIds.length
    ? await closeTabRepo.listLatestRetencaoByContact({ contactIds })
    : [];
  const tabByContact = new Map(tabulations.map((t) => [t.contactId, t]));

  const enrich = await closeTabRepo.enrichContacts(contactIds);
  const closerIds = [...tabByContact.values()]
    .map((t) => t.closedByUserId)
    .filter(Boolean);
  const users = await closeTabRepo.loadUsersById(closerIds);

  /** @type {object[]} */
  const items = [];

  for (const [cid, base] of byContact.entries()) {
    const info = enrich.get(cid) || {};
    const tab = tabByContact.get(cid) || null;
    const closer = tab?.closedByUserId ? users.get(tab.closedByUserId) : null;
    const consultorNome =
      closer?.name ||
      info.assignedName ||
      info.ownerName ||
      null;

    if (!matchesConsultor(consultorNome, consultor)) continue;

    // Período: se há from/to, exige evento no período (ativação, reply ou closedAt)
    if (from || to) {
      const dates = [base.activated_at, base.replied_at, base.received_at, tab?.closedAt].filter(
        Boolean
      );
      const inRange = dates.some((iso) => {
        const d = iso.slice(0, 10);
        if (from && d < from) return false;
        if (to && d > to) return false;
        return true;
      });
      if (!inRange && dates.length > 0) continue;
      if (!dates.length) continue;
    }

    const retention = tab?.retentionOutcome || null;
    const legacyOutcome = retentionToLegacyOutcome(retention);
    const dealId = tab?.dealId || info.dealId || base.deal_id || null;
    const item = {
      response_id: tab?.id ? `crm-tab:${tab.id}` : `crm-contact:${cid}`,
      category: base.category || category || 'processos-caa',
      master_key: base.master_key || null,
      rgm: info.rgm || base.rgm || null,
      response_rgm: info.rgm || base.rgm || null,
      telefone: info.telefone || null,
      consultor_responsavel_nome: consultorNome,
      origem_ativacao: null,
      response_kind: base.replied_at ? 'campaign_reply' : 'activation',
      message_text: tab ? `${tab.question || 'Retido?'} ${tab.answer}` : null,
      button_payload: null,
      received_at: base.replied_at || base.received_at || tab?.closedAt || base.activated_at || new Date().toISOString(),
      protocolo: null,
      nome: info.nome || base.nome || null,
      cpf: info.cpf || base.cpf || null,
      curso: info.curso || null,
      polo: info.polo || null,
      caa_status: null,
      caa_last_change_at: null,
      outcome_id: tab?.id || null,
      outcome: legacyOutcome,
      retention_outcome: retention,
      outcome_motivo: tab?.stageName || null,
      outcome_notes: tab ? `Tabulação CRM: ${tab.question} = ${tab.answer}` : null,
      outcome_occurred_at: tab?.closedAt || null,
      outcome_consultor_nome: closer?.name || null,
      outcome_has_proof: false,
      is_manual: false,
      is_legacy: false,
      source: 'novo_crm',
      contact_id: cid,
      contact_number: info.contactNumber || null,
      deal_id: dealId,
      deal_number: info.dealNumber || null,
      deal_title: info.dealTitle || null,
      deal_status: info.dealStatus || null,
      conversation_id: tab?.conversationId || null,
      tabulation_id: tab?.id || null,
      tabulation_question: tab?.question || null,
      tabulation_answer: tab?.answer || null,
      tabulation_stage_name: tab?.stageName || null,
      tabulation_stage_id: tab?.stageId || null,
      tabulation_closed_at: tab?.closedAt || null,
      tabulation_closed_by_user_id: tab?.closedByUserId || null,
      tabulation_closed_by_nome: closer?.name || null,
      tabulation_closed_by_email: closer?.email || null,
      replied_at: base.replied_at || null,
      crm_url: dealId
        ? `${CRM_BASE}/deals/${dealId}`
        : `${CRM_BASE}/contacts/${cid}`,
      activated_at: base.activated_at || null,
    };

    if (!matchesSearch(item, search)) continue;
    items.push(item);
  }

  // Legacy snapshot (badge histórico)
  for (const l of legacyRows) {
    const retention =
      l.outcome === 'revertido'
        ? 'retido'
        : l.outcome
          ? 'nao_retido'
          : null;
    const item = {
      response_id: l.response_id ? `legacy:${l.response_id}` : `legacy-row:${l.id}`,
      category: l.category,
      master_key: l.master_key,
      rgm: l.rgm,
      response_rgm: l.rgm,
      telefone: l.telefone,
      consultor_responsavel_nome: l.consultor_nome,
      origem_ativacao: l.origem_ativacao,
      response_kind: l.response_kind || 'legacy',
      message_text: null,
      button_payload: null,
      received_at: l.received_at
        ? new Date(l.received_at).toISOString()
        : l.outcome_occurred_at
          ? new Date(l.outcome_occurred_at).toISOString()
          : new Date().toISOString(),
      protocolo: l.raw?.protocolo || null,
      nome: l.nome,
      cpf: l.cpf,
      curso: null,
      polo: null,
      caa_status: null,
      caa_last_change_at: null,
      outcome_id: l.id,
      outcome: l.outcome || retentionToLegacyOutcome(retention),
      retention_outcome: retention,
      outcome_motivo: l.outcome_motivo,
      outcome_notes: l.outcome_notes,
      outcome_occurred_at: l.outcome_occurred_at
        ? new Date(l.outcome_occurred_at).toISOString()
        : null,
      outcome_consultor_nome: l.consultor_nome,
      outcome_has_proof: false,
      is_manual: false,
      is_legacy: true,
      source: 'legacy',
      contact_id: null,
      deal_id: null,
      crm_url: null,
      activated_at: null,
    };
    if (!matchesConsultor(item.consultor_responsavel_nome, consultor)) continue;
    if (!matchesSearch(item, search)) continue;
    items.push(item);
  }

  items.sort((a, b) => (sortKey(b) > sortKey(a) ? 1 : sortKey(b) < sortKey(a) ? -1 : 0));

  const total = items.length;
  const page = items.slice(offset, offset + limit);
  return { items: page, total };
}

/**
 * @param {object} filters
 */
export async function meuPainelStatsNovoCrm(filters = {}) {
  const { items } = await listMeuPainelNovoCrm({
    ...filters,
    limit: 5000,
    offset: 0,
  });

  let total_retido = 0;
  let total_nao_retido = 0;
  let total_pendente = 0;
  let total_opt_out = 0;

  for (const it of items) {
    if (it.retention_outcome === 'retido' || it.outcome === 'revertido') total_retido += 1;
    else if (it.retention_outcome === 'nao_retido' || it.outcome === 'confirmado')
      total_nao_retido += 1;
    else if (it.outcome === 'sem_contato' || it.outcome === 'outro') total_nao_retido += 1;
    else total_pendente += 1;
    if (it.response_kind === 'opt_out') total_opt_out += 1;
  }

  const total_atribuido = items.length;
  const total_tabulado = total_retido + total_nao_retido;
  const taxa_retencao = total_tabulado > 0 ? total_retido / total_tabulado : 0;

  return {
    total_atribuido,
    total_opt_out,
    total_marcado: total_tabulado,
    total_tabulado,
    total_retido,
    total_nao_retido,
    total_pendente,
    total_revertido: total_retido,
    total_confirmado: total_nao_retido,
    total_sem_contato: total_pendente,
    total_outro: 0,
    taxa_reversao: taxa_retencao,
    taxa_retencao,
  };
}
