import { Router } from 'express';
import { whatsappClient } from '../services/whatsappClient.js';
import { datacrazyClient } from '../services/datacrazyClient.js';

const router = Router();

/**
 * GET /api/templates
 * Retorna a lista padronizada de templates disponíveis no provedor configurado.
 *
 * Provedor controlado por TEMPLATES_PROVIDER (whatsapp | datacrazy).
 */
router.get('/', async (_req, res) => {
  const provider = (process.env.TEMPLATES_PROVIDER || 'whatsapp').toLowerCase();

  try {
    const templates =
      provider === 'datacrazy'
        ? await datacrazyClient.listTemplates()
        : await whatsappClient.listTemplates();

    return res.json({ provider, templates });
  } catch (err) {
    console.error('[GET /api/templates] erro:', err.message);
    return res.status(err.status || 500).json({
      error: err.message || 'Falha ao listar templates',
      provider,
      details: err.providerResponse || null,
    });
  }
});

const NAME_REGEX = /^[a-z0-9_]{1,512}$/;
const ALLOWED_CATEGORIES = new Set(['MARKETING', 'UTILITY']);

function countPlaceholders(text) {
  if (!text) return 0;
  const matches = String(text).match(/\{\{\s*\d+\s*\}\}/g) || [];
  const set = new Set(matches.map((m) => m.replace(/\D/g, '')));
  return set.size;
}

/**
 * POST /api/templates
 * Cria um novo template (MARKETING ou UTILITY) na WABA configurada.
 *
 * Body esperado:
 * {
 *   "name": "minha_promo",
 *   "category": "MARKETING" | "UTILITY",
 *   "language": "pt_BR",
 *   "header": "Olá {{1}}",          // opcional
 *   "headerExamples": ["João"],      // se header tem variáveis
 *   "body": "Texto com {{1}}",       // obrigatório
 *   "bodyExamples": ["Maio"],        // se body tem variáveis
 *   "footer": "Texto rodapé"         // opcional
 * }
 */
const ALLOWED_BUTTON_TYPES = new Set(['QUICK_REPLY', 'URL', 'PHONE_NUMBER']);
const URL_BUTTON_LIMIT = 2;
const QUICK_REPLY_LIMIT = 3;
const PHONE_BUTTON_LIMIT = 1;

function validateButtons(buttons) {
  if (!Array.isArray(buttons) || buttons.length === 0) return null;

  const counts = { QUICK_REPLY: 0, URL: 0, PHONE_NUMBER: 0 };

  for (let i = 0; i < buttons.length; i++) {
    const b = buttons[i] || {};
    const type = String(b.type || '').toUpperCase();
    const idx = `botão #${i + 1}`;

    if (!ALLOWED_BUTTON_TYPES.has(type)) {
      return `${idx}: tipo inválido. Use QUICK_REPLY, URL ou PHONE_NUMBER.`;
    }
    counts[type] += 1;

    const text = String(b.text || '').trim();
    if (!text) return `${idx}: o texto do botão é obrigatório.`;
    if (text.length > 25) return `${idx}: o texto do botão tem limite de 25 caracteres.`;

    if (type === 'URL') {
      const url = String(b.url || '').trim();
      if (!url) return `${idx}: campo "url" é obrigatório para botão URL.`;
      if (!/^https?:\/\//i.test(url)) {
        return `${idx}: a URL deve começar com http:// ou https://.`;
      }
      const placeholders = (url.match(/\{\{\s*\d+\s*\}\}/g) || []).length;
      if (placeholders > 1) {
        return `${idx}: a URL pode ter no máximo uma variável {{1}}.`;
      }
      if (placeholders === 1 && !String(b.urlExample || '').trim()) {
        return `${idx}: forneça "urlExample" pois a URL contém uma variável.`;
      }
    }

    if (type === 'PHONE_NUMBER') {
      const phone = String(b.phoneNumber || '').trim();
      if (!phone) return `${idx}: campo "phoneNumber" é obrigatório.`;
      if (!/^\+?\d{8,15}$/.test(phone)) {
        return `${idx}: phone_number deve estar em formato internacional (ex: +5511999999999).`;
      }
    }
  }

  if (counts.QUICK_REPLY > QUICK_REPLY_LIMIT) {
    return `Máximo de ${QUICK_REPLY_LIMIT} botões QUICK_REPLY.`;
  }
  if (counts.URL > URL_BUTTON_LIMIT) {
    return `Máximo de ${URL_BUTTON_LIMIT} botões URL.`;
  }
  if (counts.PHONE_NUMBER > PHONE_BUTTON_LIMIT) {
    return `Máximo de ${PHONE_BUTTON_LIMIT} botão PHONE_NUMBER.`;
  }

  return null;
}

router.post('/', async (req, res) => {
  const {
    name,
    category,
    language,
    header,
    headerExamples,
    body,
    bodyExamples,
    footer,
    buttons,
  } = req.body || {};

  if (!name || typeof name !== 'string') {
    return res.status(400).json({ error: 'Campo "name" é obrigatório.' });
  }
  if (!NAME_REGEX.test(name)) {
    return res.status(400).json({
      error:
        'Nome inválido. Use apenas letras minúsculas, números e underscore (ex: "minha_promo").',
    });
  }
  if (!category || !ALLOWED_CATEGORIES.has(String(category).toUpperCase())) {
    return res.status(400).json({
      error: 'Campo "category" deve ser "MARKETING" ou "UTILITY".',
    });
  }
  if (!body || typeof body !== 'string' || !body.trim()) {
    return res.status(400).json({ error: 'Campo "body" é obrigatório.' });
  }

  const headerVars = countPlaceholders(header);
  if (headerVars > 0) {
    if (!Array.isArray(headerExamples) || headerExamples.length !== headerVars) {
      return res.status(400).json({
        error: `O header tem ${headerVars} variável(is). Forneça ${headerVars} exemplo(s) em "headerExamples".`,
      });
    }
  }

  const bodyVars = countPlaceholders(body);
  if (bodyVars > 0) {
    if (!Array.isArray(bodyExamples) || bodyExamples.length !== bodyVars) {
      return res.status(400).json({
        error: `O body tem ${bodyVars} variável(is). Forneça ${bodyVars} exemplo(s) em "bodyExamples".`,
      });
    }
  }

  const buttonsError = validateButtons(buttons);
  if (buttonsError) {
    return res.status(400).json({ error: buttonsError });
  }

  try {
    const result = await whatsappClient.createTemplate({
      name,
      category: String(category).toUpperCase(),
      language: language || 'pt_BR',
      header,
      headerExamples,
      body,
      bodyExamples,
      footer,
      buttons,
    });

    return res.json({
      success: true,
      template: result,
    });
  } catch (err) {
    console.error('[POST /api/templates] erro:', err.message);
    return res.status(err.status || 500).json({
      success: false,
      error: err.message || 'Falha ao criar template.',
      details: err.providerResponse || null,
    });
  }
});

export default router;
