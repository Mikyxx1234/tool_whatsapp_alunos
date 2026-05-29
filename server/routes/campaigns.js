import { Router } from 'express';
import * as campaignService from '../services/campaignService.js';
import * as campaignQueue from '../services/campaignQueueService.js';
import * as eventRepo from '../repositories/eventRepository.js';
import * as contactRepo from '../repositories/contactRepository.js';
import * as campaignRepo from '../repositories/campaignRepository.js';
import { buildCsv, sanitizeFilename } from '../utils/csvBuilder.js';
import { FAILURE_REASON_LABELS } from '../utils/failureClassifier.js';

const router = Router();

function handleError(res, err) {
  console.error('[campaigns]', err.message);
  res.status(err.status || 500).json({
    error: err.message || 'Erro interno',
    details: err.providerResponse || null,
  });
}

/* ------------------------------------------------------------------ */
/* CRUD básico                                                        */
/* ------------------------------------------------------------------ */

router.get('/', async (req, res) => {
  try {
    const limit = Math.min(parseInt(req.query.limit, 10) || 50, 200);
    const offset = parseInt(req.query.offset, 10) || 0;
    const status = req.query.status || undefined;
    const typeCode = req.query.type || undefined;
    const campaigns = await campaignService.listCampaigns({ limit, offset, status, typeCode });
    res.json({ campaigns });
  } catch (err) {
    handleError(res, err);
  }
});

router.post('/', async (req, res) => {
  try {
    const campaign = await campaignService.createCampaign(req.body || {});
    res.status(201).json({ campaign });
  } catch (err) {
    handleError(res, err);
  }
});

router.get('/:id', async (req, res) => {
  try {
    const campaign = await campaignService.getCampaign(req.params.id);
    res.json({ campaign });
  } catch (err) {
    handleError(res, err);
  }
});

router.get('/:id/contacts', async (req, res) => {
  try {
    const limit = Math.min(parseInt(req.query.limit, 10) || 500, 2000);
    const offset = parseInt(req.query.offset, 10) || 0;
    const status = req.query.status || undefined;
    const contacts = await campaignService.listCampaignContacts(req.params.id, {
      limit,
      offset,
      status,
    });
    res.json({ contacts });
  } catch (err) {
    handleError(res, err);
  }
});

/* ------------------------------------------------------------------ */
/* Contagem por categoria de export (não encontrados, inválidos etc.) */
/* ------------------------------------------------------------------ */

router.get('/:id/export-counts', async (req, res) => {
  try {
    const counts = await contactRepo.countByExportCategory(req.params.id);
    res.json({ counts });
  } catch (err) {
    handleError(res, err);
  }
});

/* ------------------------------------------------------------------ */
/* Export CSV de contatos por categoria                                */
/*   ?categories=failed,invalid,duplicate,not_on_whatsapp,sent,pending */
/* ------------------------------------------------------------------ */

const EXPORT_CATEGORY_LABEL = {
  failed: 'falhas-no-envio',
  invalid: 'invalidos',
  duplicate: 'duplicados',
  not_on_whatsapp: 'nao-encontrados',
  sent: 'enviados',
  pending: 'pendentes',
};

router.get('/:id/contacts/export', async (req, res) => {
  try {
    const raw = String(req.query.categories || 'failed').trim();
    const categories = raw
      .split(',')
      .map((s) => s.trim())
      .filter((s) => s in EXPORT_CATEGORY_LABEL);

    if (categories.length === 0) {
      return res.status(400).json({
        error:
          'Parâmetro "categories" inválido. Valores aceitos: ' +
          Object.keys(EXPORT_CATEGORY_LABEL).join(', '),
      });
    }

    const campaign = await campaignRepo.findSummaryById(req.params.id);
    if (!campaign) {
      return res.status(404).json({ error: 'Campanha não encontrada.' });
    }

    const rows = await contactRepo.listForExport(req.params.id, categories);

    const csv = buildCsv(rows, {
      columns: [
        { key: 'phone', header: 'telefone_original' },
        { key: 'normalized_phone', header: 'telefone_normalizado' },
        { key: 'name', header: 'nome' },
        { key: 'email', header: 'email' },
        { key: 'cpf', header: 'cpf' },
        { key: 'student_id', header: 'student_id' },
        { key: 'course', header: 'curso' },
        { key: 'origem', header: 'origem' },
        { key: 'validation_status', header: 'validacao' },
        { key: 'send_status', header: 'envio' },
        {
          key: 'failure_reason',
          header: 'motivo_falha',
          value: (r) =>
            r.failure_reason
              ? FAILURE_REASON_LABELS[r.failure_reason] || r.failure_reason
              : '',
        },
        { key: 'error_message', header: 'mensagem_erro' },
        { key: 'sent_at', header: 'enviado_em' },
        { key: 'created_at', header: 'criado_em' },
      ],
    });

    const slug = categories
      .map((c) => EXPORT_CATEGORY_LABEL[c])
      .join('+');
    const fileName = sanitizeFilename(
      `campanha_${campaign.name || campaign.id}_${slug}.csv`
    );

    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${fileName}"`);
    res.send(csv);
  } catch (err) {
    handleError(res, err);
  }
});

router.get('/:id/events', async (req, res) => {
  try {
    const limit = Math.min(parseInt(req.query.limit, 10) || 100, 500);
    const events = await eventRepo.listByCampaign(req.params.id, { limit });
    res.json({ events });
  } catch (err) {
    handleError(res, err);
  }
});

/* ------------------------------------------------------------------ */
/* Contatos / Validação                                               */
/* ------------------------------------------------------------------ */

router.post('/:id/contacts', async (req, res) => {
  try {
    const { contacts, sourceFileName } = req.body || {};
    if (!Array.isArray(contacts)) {
      return res.status(400).json({ error: 'Campo "contacts" deve ser um array.' });
    }
    const result = await campaignService.addContacts(
      req.params.id,
      contacts,
      sourceFileName
    );
    res.json(result);
  } catch (err) {
    handleError(res, err);
  }
});

/* ------------------------------------------------------------------ */
/* Controle do disparo                                                */
/* ------------------------------------------------------------------ */

router.post('/:id/start', async (req, res) => {
  try {
    const { intervalSeconds, dailyLimit } = req.body || {};
    const result = await campaignQueue.start(req.params.id, {
      intervalSeconds,
      dailyLimit,
    });
    res.json(result);
  } catch (err) {
    handleError(res, err);
  }
});

router.post('/:id/pause', async (req, res) => {
  try {
    const result = await campaignQueue.pause(req.params.id);
    res.json(result);
  } catch (err) {
    handleError(res, err);
  }
});

router.post('/:id/cancel', async (req, res) => {
  try {
    const result = await campaignQueue.cancel(req.params.id);
    res.json(result);
  } catch (err) {
    handleError(res, err);
  }
});

router.post('/:id/mark-not-interacted', async (req, res) => {
  try {
    const hours = Number(req.body?.hoursAfterSend) || 24;
    const result = await campaignService.markNotInteracted(req.params.id, hours);
    res.json(result);
  } catch (err) {
    handleError(res, err);
  }
});

export default router;
