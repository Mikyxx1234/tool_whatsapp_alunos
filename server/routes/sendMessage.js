import { Router } from 'express';
import { datacrazyClient } from '../services/datacrazyClient.js';
import { requireApiKey } from '../middleware/requireApiKey.js';

const router = Router();

/**
 * POST /api/send-message
 * Body:
 * {
 *   "phone": "5511999999999",
 *   "templateName": "nome_template",
 *   "language": "pt_BR",
 *   "variables": { "nome": "João", "curso": "Administração" }
 * }
 */
router.post('/', requireApiKey, async (req, res) => {
  const { phone, templateName, language, variables } = req.body || {};

  if (!phone || typeof phone !== 'string') {
    return res.status(400).json({
      success: false,
      phone: phone || null,
      error: 'Campo "phone" é obrigatório.',
    });
  }
  if (!templateName || typeof templateName !== 'string') {
    return res.status(400).json({
      success: false,
      phone,
      error: 'Campo "templateName" é obrigatório.',
    });
  }

  try {
    const result = await datacrazyClient.sendTemplateMessage({
      phone,
      templateName,
      language: language || 'pt_BR',
      variables: variables || {},
    });

    return res.json({
      success: true,
      phone,
      messageId: result.messageId,
    });
  } catch (err) {
    console.error('[POST /api/send-message] erro:', err.message);
    return res.status(err.status || 500).json({
      success: false,
      phone,
      error: err.message || 'Falha ao enviar mensagem.',
      details: err.providerResponse || null,
    });
  }
});

export default router;
