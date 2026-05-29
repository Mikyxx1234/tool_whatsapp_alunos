/**
 * Cliente HTTP para a WhatsApp Cloud API (Meta / Graph API).
 *
 * Usado principalmente para listar templates aprovados na conta WABA.
 *
 * Doc: https://developers.facebook.com/docs/whatsapp/business-management-api/message-templates
 */

function getConfig() {
  const apiKey = process.env.WHATSAPP_API_KEY;
  const baseUrl = (process.env.WHATSAPP_BASE_URL || 'https://graph.facebook.com/v20.0').replace(/\/+$/, '');
  const wabaId = process.env.WHATSAPP_BUSINESS_ACCOUNT_ID;
  const phoneNumberId = process.env.WHATSAPP_PHONE_NUMBER_ID;

  if (!apiKey) {
    throw new Error('WHATSAPP_API_KEY não configurada. Defina no arquivo .env.');
  }
  if (!wabaId) {
    throw new Error(
      'WHATSAPP_BUSINESS_ACCOUNT_ID não configurada. ' +
        'Encontre o ID em Meta Business Manager > Conta do WhatsApp.'
    );
  }

  return { apiKey, baseUrl, wabaId, phoneNumberId };
}

function getSendConfig() {
  const config = getConfig();
  if (!config.phoneNumberId) {
    throw new Error(
      'WHATSAPP_PHONE_NUMBER_ID não configurado. Necessário para enviar mensagens via Cloud API.'
    );
  }
  return config;
}

async function listTemplates() {
  const { apiKey, baseUrl, wabaId } = getConfig();
  const url = `${baseUrl}/${wabaId}/message_templates?limit=200`;

  const response = await fetch(url, {
    method: 'GET',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      Accept: 'application/json',
    },
  });

  const text = await response.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = { raw: text };
  }

  if (!response.ok) {
    const message =
      data?.error?.message ||
      data?.message ||
      `WhatsApp Cloud API respondeu com status ${response.status}`;
    const error = new Error(message);
    error.status = response.status;
    error.providerResponse = data;
    throw error;
  }

  const list = Array.isArray(data?.data) ? data.data : [];

  return list.map((tpl) => ({
    id: tpl.id || tpl.name,
    name: tpl.name,
    language: tpl.language || 'pt_BR',
    status: (tpl.status || 'PENDING').toUpperCase(),
    category: (tpl.category || 'MARKETING').toUpperCase(),
    components: tpl.components || [],
  }));
}

/**
 * Cria um template de mensagem no WhatsApp (MARKETING ou UTILITY).
 *
 * Doc: https://developers.facebook.com/docs/whatsapp/business-management-api/message-templates
 *
 * @param {Object} payload
 * @param {string} payload.name           - identificador snake_case, lowercase
 * @param {('MARKETING'|'UTILITY')} payload.category
 * @param {string} payload.language       - ex: "pt_BR"
 * @param {string} [payload.header]       - texto do header (suporta {{1}}, etc.)
 * @param {string[]} [payload.headerExamples]
 * @param {string} payload.body           - obrigatório (suporta {{1}}, {{2}}...)
 * @param {string[]} [payload.bodyExamples]
 * @param {string} [payload.footer]
 * @param {Array<{type:'QUICK_REPLY'|'URL'|'PHONE_NUMBER',text:string,url?:string,urlExample?:string,phoneNumber?:string}>} [payload.buttons]
 */
async function createTemplate(payload) {
  const { apiKey, baseUrl, wabaId } = getConfig();
  const url = `${baseUrl}/${wabaId}/message_templates`;

  const components = [];

  if (payload.header && payload.header.trim()) {
    const headerComponent = {
      type: 'HEADER',
      format: 'TEXT',
      text: payload.header.trim(),
    };
    if (payload.headerExamples && payload.headerExamples.length > 0) {
      headerComponent.example = { header_text: payload.headerExamples };
    }
    components.push(headerComponent);
  }

  if (!payload.body || !payload.body.trim()) {
    const err = new Error('Campo "body" é obrigatório.');
    err.status = 400;
    throw err;
  }

  const bodyComponent = {
    type: 'BODY',
    text: payload.body.trim(),
  };
  if (payload.bodyExamples && payload.bodyExamples.length > 0) {
    bodyComponent.example = { body_text: [payload.bodyExamples] };
  }
  components.push(bodyComponent);

  if (payload.footer && payload.footer.trim()) {
    components.push({
      type: 'FOOTER',
      text: payload.footer.trim(),
    });
  }

  if (Array.isArray(payload.buttons) && payload.buttons.length > 0) {
    const buttons = payload.buttons.map((b) => {
      const t = String(b.type || '').toUpperCase();
      if (t === 'QUICK_REPLY') {
        return { type: 'QUICK_REPLY', text: String(b.text || '').trim() };
      }
      if (t === 'URL') {
        const obj = {
          type: 'URL',
          text: String(b.text || '').trim(),
          url: String(b.url || '').trim(),
        };
        if (b.urlExample && String(b.urlExample).trim()) {
          obj.example = [String(b.urlExample).trim()];
        }
        return obj;
      }
      if (t === 'PHONE_NUMBER') {
        return {
          type: 'PHONE_NUMBER',
          text: String(b.text || '').trim(),
          phone_number: String(b.phoneNumber || '').trim(),
        };
      }
      const err = new Error(`Tipo de botão inválido: ${t}`);
      err.status = 400;
      throw err;
    });
    components.push({ type: 'BUTTONS', buttons });
  }

  const body = {
    name: payload.name,
    category: payload.category,
    language: payload.language || 'pt_BR',
    components,
  };

  const response = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
      Accept: 'application/json',
    },
    body: JSON.stringify(body),
  });

  const text = await response.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = { raw: text };
  }

  if (!response.ok) {
    const message =
      data?.error?.error_user_msg ||
      data?.error?.message ||
      data?.message ||
      `WhatsApp Cloud API respondeu com status ${response.status}`;
    const err = new Error(message);
    err.status = response.status;
    err.providerResponse = data;
    throw err;
  }

  return {
    id: data?.id || null,
    status: (data?.status || 'PENDING').toUpperCase(),
    category: (data?.category || payload.category).toUpperCase(),
    raw: data,
  };
}

/**
 * Localiza o template já carregado e extrai a sequência de variáveis
 * declaradas no header e no body, na ordem em que aparecem.
 *
 * Retorna a lista de chaves esperadas (ex: ['1','2','3']).
 */
function extractTemplateVariableOrder(templateComponents = []) {
  const out = { header: [], body: [], buttons: [] };
  const re = /\{\{(\d+)\}\}/g;

  for (const comp of templateComponents || []) {
    const type = String(comp.type || '').toUpperCase();
    const text = String(comp.text || '');
    const matches = [...text.matchAll(re)].map((m) => m[1]);
    if (type === 'HEADER') out.header = matches;
    else if (type === 'BODY') out.body = matches;
  }
  return out;
}

/**
 * Envia uma mensagem de template via WhatsApp Cloud API.
 *
 * Doc: https://developers.facebook.com/docs/whatsapp/cloud-api/reference/messages
 *
 * @param {Object} params
 * @param {string}   params.phone           - telefone normalizado (ex: 5511999887766)
 * @param {string}   params.templateName
 * @param {string}   params.language        - ex: 'pt_BR'
 * @param {Object}   [params.variables]     - mapa de variáveis (chaves '1','2'... ou nomes amigáveis)
 * @param {Array}    [params.templateComponents] - componentes do template (vindos do listTemplates) p/ saber a ordem
 */
async function sendTemplateMessage({
  phone,
  templateName,
  language,
  variables = {},
  templateComponents = [],
}) {
  const { apiKey, baseUrl, phoneNumberId } = getSendConfig();
  const url = `${baseUrl}/${phoneNumberId}/messages`;

  // monta os components com base na ORDEM declarada no template
  const order = extractTemplateVariableOrder(templateComponents);
  const components = [];

  function resolveVar(key) {
    return (
      variables[key] ??
      variables[String(key)] ??
      variables[`{{${key}}}`] ??
      ''
    );
  }

  if (order.header.length > 0) {
    components.push({
      type: 'header',
      parameters: order.header.map((k) => ({
        type: 'text',
        text: String(resolveVar(k) ?? ''),
      })),
    });
  }

  if (order.body.length > 0) {
    components.push({
      type: 'body',
      parameters: order.body.map((k) => ({
        type: 'text',
        text: String(resolveVar(k) ?? ''),
      })),
    });
  }

  const body = {
    messaging_product: 'whatsapp',
    recipient_type: 'individual',
    to: phone,
    type: 'template',
    template: {
      name: templateName,
      language: { code: language || 'pt_BR' },
      ...(components.length > 0 ? { components } : {}),
    },
  };

  let response;
  try {
    response = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: JSON.stringify(body),
    });
  } catch (err) {
    const e = new Error(
      `Falha de rede ao chamar WhatsApp Cloud API: ${err.message}`
    );
    e.cause = err;
    throw e;
  }

  const text = await response.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = { raw: text };
  }

  if (!response.ok) {
    const errInfo = data?.error || {};
    const message =
      errInfo.error_user_msg ||
      errInfo.message ||
      data?.message ||
      `WhatsApp Cloud API respondeu com status ${response.status}`;
    const err = new Error(message);
    err.status = response.status;
    err.providerResponse = data;
    err.retryAfterSeconds = parseRetryAfter(response.headers.get('retry-after'));
    throw err;
  }

  const messageId = data?.messages?.[0]?.id || null;

  return {
    messageId,
    raw: data,
  };
}

function parseRetryAfter(header) {
  if (!header) return null;
  const n = Number(header);
  if (Number.isFinite(n) && n > 0) return n;
  // se for um http-date, ignora — usa default
  return null;
}

export const whatsappClient = {
  listTemplates,
  createTemplate,
  sendTemplateMessage,
};
