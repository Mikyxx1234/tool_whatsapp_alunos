import { Router } from 'express';
import * as studentRepo from '../repositories/studentRepository.js';
import * as scheduledEventRepo from '../repositories/scheduledEventRepository.js';
import * as timelineRepo from '../repositories/timelineRepository.js';
import {
  generateJourneyEventsForStudent,
  generateJourneyEventsBatch,
  cancelFutureEventsForStudent,
} from '../services/journeySchedulerService.js';
import { applyStudentJourney } from '../services/decisionEngine.js';

const router = Router();

function handleError(res, err) {
  console.error('[students]', err.message);
  res.status(err.status || 500).json({ error: err.message || 'Erro interno' });
}

/* ---------------------------------------------------------------- */
/* CRUD                                                             */
/* ---------------------------------------------------------------- */

router.get('/', async (req, res) => {
  try {
    const limit = Math.min(parseInt(req.query.limit, 10) || 100, 500);
    const offset = parseInt(req.query.offset, 10) || 0;
    const fluxo = req.query.fluxo || undefined;
    const status = req.query.status || undefined;
    const search = req.query.search || undefined;
    const students = await studentRepo.list({
      fluxo, status, search, limit, offset,
    });
    res.json({ students });
  } catch (err) { handleError(res, err); }
});

router.post('/', async (req, res) => {
  try {
    const { student, created } = await studentRepo.upsertByKey(req.body || {});
    await timelineRepo.record({
      studentId: student.id,
      eventType: created ? 'student_created' : 'student_updated',
      title: created ? 'Aluno cadastrado' : 'Aluno atualizado',
      description: `Origem: ${req.body?.origem || 'manual'}.`,
      metadata: { source: 'api', created },
    }).catch(() => {});
    res.status(created ? 201 : 200).json({ student, created });
  } catch (err) { handleError(res, err); }
});

router.get('/:id', async (req, res) => {
  try {
    const student = await studentRepo.findById(req.params.id);
    if (!student) return res.status(404).json({ error: 'Aluno não encontrado.' });
    res.json({ student });
  } catch (err) { handleError(res, err); }
});

/* ---------------------------------------------------------------- */
/* Importação em massa (vinda do CSV processado pelo front)         */
/* Body: { students: [...], generateJourney?: boolean, termId? }     */
/* ---------------------------------------------------------------- */
router.post('/import', async (req, res) => {
  try {
    const list = Array.isArray(req.body?.students) ? req.body.students : null;
    if (!list) {
      return res.status(400).json({ error: 'Campo "students" deve ser um array.' });
    }
    const generateJourney = req.body?.generateJourney !== false;
    const termId = req.body?.termId || req.body?.term_id || null;

    const enriched = termId
      ? list.map((s) => ({ ...s, term_id: termId }))
      : list;

    const upsertResult = await studentRepo.bulkUpsert(enriched);

    // timeline básica para cada aluno criado/atualizado
    for (const s of upsertResult.students) {
      await timelineRepo.record({
        studentId: s.id,
        eventType: 'student_imported',
        title: 'Aluno importado via CSV',
        metadata: { source: 'csv-import' },
      }).catch(() => {});
    }

    let journeyResults = [];
    let journeyErrors = [];
    const fluxoCounts = { A: 0, B: 0, C: 0, INDEFINIDO: 0 };
    let totalEventsGenerated = 0;

    if (generateJourney) {
      const ids = upsertResult.students.map((s) => s.id);
      const r = await generateJourneyEventsBatch(ids);
      journeyResults = r.results;
      journeyErrors = r.errors;
      for (const item of journeyResults) {
        const key = item.fluxo || 'INDEFINIDO';
        fluxoCounts[key] = (fluxoCounts[key] || 0) + 1;
        totalEventsGenerated += (item.events || []).length;
      }
    } else {
      // só calcula gap/fluxo sem gerar eventos
      for (const s of upsertResult.students) {
        try {
          const result = await applyStudentJourney(s.id);
          const key = result.fluxo || 'INDEFINIDO';
          fluxoCounts[key] = (fluxoCounts[key] || 0) + 1;
        } catch (e) {
          journeyErrors.push({ studentId: s.id, error: e.message });
        }
      }
    }

    res.json({
      imported: upsertResult.created,
      updated: upsertResult.updated,
      total: upsertResult.students.length,
      errors: [...upsertResult.errors, ...journeyErrors],
      fluxoCounts,
      totalEventsGenerated,
      students: upsertResult.students,
    });
  } catch (err) { handleError(res, err); }
});

/* ---------------------------------------------------------------- */
/* Importação Blackboard (XLSX/CSV processado pelo front)            */
/*   Body: { rows: [...], termId?, accessOnly?, generateJourney? }   */
/* ---------------------------------------------------------------- */
router.post('/import-blackboard', async (req, res) => {
  try {
    const rows = Array.isArray(req.body?.rows) ? req.body.rows : null;
    if (!rows) {
      return res.status(400).json({ error: 'Campo "rows" deve ser um array.' });
    }
    const termId = req.body?.termId || req.body?.term_id || null;
    const accessOnly = Boolean(req.body?.accessOnly);
    const generateJourney = !accessOnly && req.body?.generateJourney !== false;

    const enriched = rows.map((r) => ({
      nome: r.nome || r.aluno || r.name,
      rgm: r.rgm || r.RGM,
      email: r.email,
      telefone: r.telefone || r.celular,
      curso: r.curso,
      polo: r.polo,
      ciclo: r.ciclo,
      tipo_matricula: r.tipo_matricula,
      instituicao: r.instituicao,
      empresa: r.empresa,
      ultimo_acesso_blackboard: r.ultimo_acesso_blackboard || r.ultimo_acesso || null,
      ultimo_acesso: r.ultimo_acesso_blackboard || r.ultimo_acesso || null,
      minutos_acesso: r.minutos_acesso ?? r.minutos ?? null,
      total_interacoes: r.total_interacoes ?? r.interacoes ?? null,
      total_registros: r.total_registros ?? null,
      term_id: termId,
      fonte_dados: 'blackboard',
      raw_data: r.raw_data || r,
    }));

    const CHUNK = 200;
    const aggregate = { students: [], created: 0, updated: 0, errors: [] };
    for (let i = 0; i < enriched.length; i += CHUNK) {
      const slice = enriched.slice(i, i + CHUNK);
      const r = await studentRepo.bulkUpsert(slice);
      aggregate.students.push(...r.students);
      aggregate.created += r.created;
      aggregate.updated += r.updated;
      // shifta os índices dos erros pro range global
      aggregate.errors.push(
        ...r.errors.map((e) => ({ ...e, index: (e.index ?? 0) + i }))
      );
    }

    // Timeline leve só uma entrada — evita inflar 25k linhas
    if (aggregate.students.length > 0) {
      const sample = aggregate.students.slice(0, 50);
      for (const s of sample) {
        await timelineRepo.record({
          studentId: s.id,
          eventType: 'blackboard_sync',
          title: 'Sincronização com Blackboard',
          description: `Dados de acesso atualizados${
            s.ultimo_acesso_blackboard
              ? ` (último acesso: ${new Date(s.ultimo_acesso_blackboard).toLocaleDateString('pt-BR')})`
              : ''
          }.`,
          metadata: {
            minutos_acesso: s.minutos_acesso,
            total_interacoes: s.total_interacoes,
            term_id: termId,
          },
        }).catch(() => {});
      }
    }

    let journeyResults = [];
    let journeyErrors = [];
    const fluxoCounts = { A: 0, B: 0, C: 0, INDEFINIDO: 0 };
    let totalEventsGenerated = 0;

    if (generateJourney) {
      const ids = aggregate.students.map((s) => s.id);
      const r = await generateJourneyEventsBatch(ids);
      journeyResults = r.results;
      journeyErrors = r.errors;
      for (const item of journeyResults) {
        const key = item.fluxo || 'INDEFINIDO';
        fluxoCounts[key] = (fluxoCounts[key] || 0) + 1;
        totalEventsGenerated += (item.events || []).length;
      }
    }

    res.json({
      imported: aggregate.created,
      updated: aggregate.updated,
      total: aggregate.students.length,
      errors: [...aggregate.errors, ...journeyErrors].slice(0, 200),
      fluxoCounts,
      totalEventsGenerated,
      accessOnly,
      term_id: termId,
    });
  } catch (err) { handleError(res, err); }
});

/* ---------------------------------------------------------------- */
/* Override individual de datas                                     */
/* ---------------------------------------------------------------- */
router.patch('/:id', async (req, res) => {
  try {
    const allowed = [
      'nome', 'telefone', 'email', 'cpf', 'curso', 'polo', 'origem',
      'data_matricula', 'data_inicio_conteudo', 'data_acesso_liberado',
      'override_data_inicio_conteudo', 'override_data_acesso_liberado',
      'term_id', 'rgm', 'ciclo', 'status',
    ];
    const partial = {};
    for (const k of allowed) if (k in req.body) partial[k] = req.body[k];
    const updated = await studentRepo.patchStudent(req.params.id, partial);
    if (!updated) return res.status(404).json({ error: 'Aluno não encontrado.' });
    res.json({ student: updated });
  } catch (err) { handleError(res, err); }
});

/* ---------------------------------------------------------------- */
/* Régua / eventos / timeline                                       */
/* ---------------------------------------------------------------- */
router.post('/:id/recalculate-journey', async (req, res) => {
  try {
    const result = await generateJourneyEventsForStudent(req.params.id, {
      recalculateFlow: true,
    });
    res.json(result);
  } catch (err) { handleError(res, err); }
});

router.post('/:id/cancel-future-events', async (req, res) => {
  try {
    const reason = req.body?.reason || 'Cancelado pelo usuário';
    const cancelled = await cancelFutureEventsForStudent(req.params.id, reason);
    res.json({ cancelled });
  } catch (err) { handleError(res, err); }
});

router.get('/:id/timeline', async (req, res) => {
  try {
    const limit = Math.min(parseInt(req.query.limit, 10) || 200, 500);
    const items = await timelineRepo.listByStudent(req.params.id, { limit });
    res.json({ timeline: items });
  } catch (err) { handleError(res, err); }
});

router.get('/:id/scheduled-events', async (req, res) => {
  try {
    const events = await scheduledEventRepo.listByStudent(req.params.id);
    res.json({ events });
  } catch (err) { handleError(res, err); }
});

export default router;
