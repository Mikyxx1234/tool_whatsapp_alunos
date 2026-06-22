/**
 * Helpers para criação da anotação automática no DataCrazy a cada envio do disparador.
 */

export function datacrazyDispatchNoteEnabled() {
  const v = String(process.env.DATACRAZY_DISPATCH_NOTE_ENABLED ?? 'true').toLowerCase();
  return v === 'true' || v === '1' || v === 'yes' || v === 'on';
}

/** Em lotes grandes, anotações sobrecarregam a API — padrão desliga acima de 250. */
export function shouldCreateDispatchNote(batchSize) {
  if (!datacrazyDispatchNoteEnabled()) return false;
  const max = Number(process.env.DATACRAZY_DISPATCH_NOTE_MAX_BATCH);
  const limit = Number.isFinite(max) ? max : 250;
  if (limit <= 0) return true;
  return batchSize <= limit;
}

const CATEGORY_LABELS = {
  'processos-caa':      'Processos CAA',
  'docs-pendentes':     'Docs Pendentes',
  'financeiro':         'Financeiro',
  'acessos-blackboard': 'Acessos Blackboard',
  'provavel-evasao':    'Provável Evasão',
  'aguardando-inicio':  'Aguardando Início',
  rematricula:          'Rematrícula',
};

/**
 * Monta o texto da anotação que será postada no card do lead no DataCrazy.
 *
 * @param {object} params
 * @param {string} params.category
 * @param {string} [params.templateName]
 * @param {string} [params.renderedText]
 * @param {string} [params.operatorNome]
 * @param {Date}   [params.timestamp]
 * @returns {string}
 */
export function buildDispatchNote({ category, templateName, renderedText, operatorNome, timestamp }) {
  const ts = (timestamp instanceof Date ? timestamp : new Date()).toLocaleString('pt-BR', {
    timeZone: 'America/Sao_Paulo',
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
  const lines = [
    `[Disparador WhatsApp] ${ts} (BRT)`,
    `Categoria: ${CATEGORY_LABELS[category] || category}`,
    `Template: ${templateName || '—'}`,
    `Disparado por: ${operatorNome || 'Disparador automático'}`,
    '---',
    renderedText || '(sem texto renderizado)',
  ];
  return lines.join('\n');
}
