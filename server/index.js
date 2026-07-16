import './boot-env.js';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import express from 'express';
import cors from 'cors';

import templatesRoute from './routes/templates.js';
import sendMessageRoute from './routes/sendMessage.js';
import campaignsRoute from './routes/campaigns.js';
import campaignTypesRoute from './routes/campaignTypes.js';
import webhooksRoute from './routes/webhooks.js';
import studentsRoute from './routes/students.js';
import journeysRoute from './routes/journeys.js';
import scheduledEventsRoute from './routes/scheduledEvents.js';
import academicTermsRoute from './routes/academicTerms.js';
import journeySettingsRoute from './routes/journeySettings.js';
import reportsRoute from './routes/reports.js';
import baseUploadsRoute from './routes/baseUploads.js';
import activationRoute from './routes/activation.js';
import maintenanceRoute from './routes/maintenance.js';
import cyclesRoute from './routes/cycles.js';
import painelRoute from './routes/painel.js';
import consultorMetasRoute from './routes/consultorMetas.js';

import { isDbConfigured } from './db/client.js';
import { startScheduler } from './services/schedulerService.js';
import { isApiKeyEnforced } from './middleware/requireApiKey.js';
import { startDatacrazyCacheSyncCron } from './services/datacrazyLeadCacheSyncService.js';
import { startAlunoPhoneLookupCron } from './services/alunoPhoneLookupService.js';

const app = express();
const PORT = Number(process.env.PORT) || 3001;

app.use(cors());
app.use(express.json({ limit: process.env.JSON_BODY_LIMIT || '100mb' }));

app.get('/api/health', (_req, res) => {
  const payload = {
    ok: true,
    service: 'disparador-whatsapp-backend',
    time: new Date().toISOString(),
  };
  if (!isApiKeyEnforced()) {
    payload.env = {
      hasDatacrazyKey: Boolean(process.env.DATACRAZY_API_KEY),
      hasWhatsappKey: Boolean(process.env.WHATSAPP_API_KEY),
      hasDatabase: isDbConfigured(),
      templatesProvider: process.env.TEMPLATES_PROVIDER || 'whatsapp',
    };
  }
  res.json(payload);
});

app.use('/api/templates', templatesRoute);
app.use('/api/send-message', sendMessageRoute);
app.use('/api/campaigns', campaignsRoute);
app.use('/api/campaign-types', campaignTypesRoute);
app.use('/api/webhooks', webhooksRoute);
app.use('/api/students', studentsRoute);
app.use('/api/journeys', journeysRoute);
app.use('/api/scheduled-events', scheduledEventsRoute);
app.use('/api/academic-terms', academicTermsRoute);
app.use('/api/journey-settings', journeySettingsRoute);
app.use('/api/reports', reportsRoute);
app.use('/api/base-uploads', baseUploadsRoute);
app.use('/api/activation', activationRoute);
app.use('/api/maintenance', maintenanceRoute);
app.use('/api/cycles', cyclesRoute);
app.use('/api/painel', painelRoute);
app.use('/api/consultor-metas', consultorMetasRoute);

// Em produção (container Docker), o mesmo processo serve o build estático
// do frontend (Vite -> dist/). Em dev, o Vite roda na porta 5173 e proxy-a
// /api para este backend, então este bloco é ignorado.
const __dirname = path.dirname(fileURLToPath(import.meta.url));

fs.mkdirSync(path.resolve(__dirname, 'uploads/manual_outcomes'), { recursive: true });

const distDir = path.resolve(__dirname, '..', 'dist');
if (fs.existsSync(distDir)) {
  app.use(express.static(distDir));
  app.get(/^\/(?!api\/).*/, (_req, res) => {
    res.sendFile(path.join(distDir, 'index.html'));
  });
} else {
  console.warn(`[server] dist/ não encontrado em ${distDir}; servindo apenas /api/*.`);
}

app.use((err, _req, res, _next) => {
  console.error('[server] erro não tratado:', err);
  res.status(500).json({ error: err.message || 'Erro interno' });
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`[server] backend rodando em http://0.0.0.0:${PORT}`);
  if (!process.env.DATACRAZY_API_KEY) {
    console.warn('[server] AVISO: DATACRAZY_API_KEY não configurada.');
  }
  if (!process.env.WHATSAPP_API_KEY) {
    console.warn('[server] AVISO: WHATSAPP_API_KEY não configurada.');
  }
  if (!isDbConfigured()) {
    console.warn(
      '[server] AVISO: DATABASE_URL não configurada. ' +
        'Endpoints /api/campaigns, /api/campaign-types e /api/webhooks vão falhar até o banco estar configurado.'
    );
  }

  // Sobe o scheduler in-process da Régua Inteligente.
  // Não falha o boot se algo der errado aqui.
  try {
    startScheduler();
  } catch (err) {
    console.error('[server] falha ao iniciar scheduler:', err.message);
  }

  if (isDbConfigured()) {
    setTimeout(() => {
      import('./services/baseComparisonService.js')
        .then((m) => m.startComparisonBuildIfNeeded())
        .catch((err) => {
          console.warn('[server] pré-aquecimento comparação:', err.message);
        });
    }, 3000);
    setTimeout(() => {
      import('./repositories/reportRepository.js')
        .then((m) => m.prewarmCaaOverviewMetadata())
        .catch((err) => {
          console.warn('[server] pré-aquecimento overview CAA:', err.message);
        });
    }, 8000);

    // Cron interno de limpeza de origem_ativacao stale no CRM.
    // Roda a cada 24h. Endpoint manual: POST /api/maintenance/clean-stale-origem-ativacao.
    // Backup defensivo caso o n8n Schedule Trigger caia.
    const CLEANUP_ORIGEM_ATIVACAO_INTERVAL_MS = 24 * 60 * 60 * 1000;
    setInterval(() => {
      import('./services/activationOrigemCleanupService.js')
        .then((m) => m.cleanStaleOrigemAtivacao())
        .then((r) => {
          console.log(
            `[cleanup origem_ativacao] scanned=${r.scanned} cleaned=${r.cleaned} failed=${r.failed} window=${r.stale_window_hours}h`
          );
        })
        .catch((err) => {
          console.error('[cleanup origem_ativacao] FAIL:', err.message);
        });
    }, CLEANUP_ORIGEM_ATIVACAO_INTERVAL_MS);

    // Cron interno: limpeza de tags ativacao-* no Novo CRM (mesma janela stale).
    setInterval(() => {
      import('./services/activationNovoCrmTagCleanupService.js')
        .then((m) => m.cleanStaleActivationTags())
        .then((r) => {
          if (r.skipped_no_config) {
            console.log('[cleanup activation-tags] skip: NOVO_CRM não configurado');
            return;
          }
          console.log(
            `[cleanup activation-tags] scanned=${r.scanned} cleaned=${r.cleaned} failed=${r.failed} window=${r.stale_window_hours}h`
          );
        })
        .catch((err) => {
          console.error('[cleanup activation-tags] FAIL:', err.message);
        });
    }, CLEANUP_ORIGEM_ATIVACAO_INTERVAL_MS);

    // Snapshot diário rematrícula (evolução EM CURSO / adimplente / inadimplente).
    const REMAT_TRACKING_INTERVAL_MS = 24 * 60 * 60 * 1000;
    setTimeout(() => {
      import('./services/rematriculaTrackingService.js')
        .then((m) => m.captureRematriculaDailyPoint({ reason: 'scheduled' }))
        .catch((err) => console.warn('[rematricula-tracking] startup:', err.message));
    }, 12_000);
    setInterval(() => {
      import('./services/rematriculaTrackingService.js')
        .then((m) => m.captureRematriculaDailyPoint({ reason: 'scheduled' }))
        .catch((err) => console.error('[rematricula-tracking] FAIL:', err.message));
    }, REMAT_TRACKING_INTERVAL_MS);

    // Cron interno de sync de desfechos CAA via CRM DataCrazy.
    // Endpoint manual: POST /api/maintenance/sync-crm-desfechos.
    const CRM_DESFECHO_SYNC_INTERVAL_HOURS = Math.max(
      1,
      parseFloat(process.env.CRM_DESFECHO_SYNC_INTERVAL_HOURS || '2') || 2
    );
    setInterval(() => {
      import('./services/crmDesfechoSyncService.js')
        .then((m) => m.syncCaaDesfechos())
        .then((r) => {
          if (r.skipped_no_config) return;
          console.log(
            `[crm-desfecho-sync] scanned=${r.scanned} revertido=${r.synced_revertido} confirmado=${r.synced_confirmado} ignored=${r.ignored} failed=${r.failed}`
          );
        })
        .catch((err) => {
          console.error('[crm-desfecho-sync] FAIL:', err.message);
        });
    }, CRM_DESFECHO_SYNC_INTERVAL_HOURS * 60 * 60 * 1000);

    // Cron interno: backfill consultor do payload + CRM para leads sem consultor.
    // Endpoint manual: POST /api/maintenance/sync-response-consultores.
    const CRM_CONSULTOR_SYNC_INTERVAL_HOURS = Math.max(
      1,
      parseFloat(process.env.CRM_CONSULTOR_SYNC_INTERVAL_HOURS || '2') || 2
    );
    setInterval(() => {
      import('./services/crmConsultorSyncService.js')
        .then((m) => m.syncResponseConsultores({ days: 30, category: 'processos-caa' }))
        .then((r) => {
          if (r.crm?.skipped_no_config && r.backfill?.consultor === 0) return;
          console.log(
            `[crm-consultor-sync] backfill_consultor=${r.backfill?.consultor ?? 0} crm_updated=${r.crm?.updated ?? 0} crm_scanned=${r.crm?.scanned ?? 0}`
          );
        })
        .catch((err) => {
          console.error('[crm-consultor-sync] FAIL:', err.message);
        });
    }, CRM_CONSULTOR_SYNC_INTERVAL_HOURS * 60 * 60 * 1000);

    // Cron diário de sync do cache persistente cpf → datacrazy_lead_id.
    // Hora configurada em DATACRAZY_CACHE_SYNC_HOUR_UTC (default 03:00 UTC).
    // Endpoint manual: POST /api/maintenance/sync-datacrazy-cache.
    try {
      startDatacrazyCacheSyncCron();
    } catch (err) {
      console.error('[server] falha ao iniciar cron cache DataCrazy:', err.message);
    }

    // Cron diário de refresh da MV nome-por-telefone (Meu Painel).
    // Hora configurada em ALUNO_PHONE_LOOKUP_REFRESH_HOUR_UTC (default 04:00 UTC).
    try {
      startAlunoPhoneLookupCron();
    } catch (err) {
      console.error('[server] falha ao iniciar cron aluno-phone-lookup:', err.message);
    }
  }
});
