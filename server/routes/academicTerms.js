import { Router } from 'express';
import * as termRepo from '../repositories/academicTermRepository.js';
import * as studentRepo from '../repositories/studentRepository.js';
import { generateJourneyEventsBatch } from '../services/journeySchedulerService.js';
import { invalidateTermsCache } from '../services/termResolverService.js';
import { invalidateActivationListCache } from '../services/activationService.js';

function bustTermCaches() {
  invalidateTermsCache();
  invalidateActivationListCache('acessos-blackboard');
  invalidateActivationListCache('aguardando-inicio');
  invalidateActivationListCache('conteudo-previo');
}

const router = Router();

function handleError(res, err) {
  console.error('[academic-terms]', err.message);
  res.status(err.status || 500).json({ error: err.message || 'Erro interno' });
}

router.get('/', async (req, res) => {
  try {
    const terms = await termRepo.list({
      ativoOnly: req.query.ativoOnly === 'true',
      search: req.query.search || undefined,
      nivel: req.query.nivel || undefined,
      ciclo: req.query.ciclo || undefined,
    });
    const counts = await termRepo.countStudentsByTerm();
    const countsMap = new Map(counts.map((c) => [c.term_id, c.total]));
    res.json({
      terms: terms.map((t) => ({
        ...t,
        total_students: countsMap.get(t.id) || 0,
      })),
    });
  } catch (err) { handleError(res, err); }
});

router.post('/', async (req, res) => {
  try {
    const term = await termRepo.create(req.body || {});
    bustTermCaches();
    res.status(201).json({ term });
  } catch (err) { handleError(res, err); }
});

router.get('/:id', async (req, res) => {
  try {
    const term = await termRepo.findById(req.params.id);
    if (!term) return res.status(404).json({ error: 'Turma não encontrada.' });
    res.json({ term });
  } catch (err) { handleError(res, err); }
});

router.put('/:id', async (req, res) => {
  try {
    const term = await termRepo.update(req.params.id, req.body || {});
    if (!term) return res.status(404).json({ error: 'Turma não encontrada.' });
    bustTermCaches();
    res.json({ term });
  } catch (err) { handleError(res, err); }
});

router.delete('/:id', async (req, res) => {
  try {
    const ok = await termRepo.remove(req.params.id);
    if (!ok) return res.status(404).json({ error: 'Turma não encontrada.' });
    bustTermCaches();
    res.status(204).end();
  } catch (err) { handleError(res, err); }
});

/**
 * Recalcula a régua de TODOS os alunos da turma. Útil ao mudar
 * inicio_conteudo / regras / ambientação.
 */
router.post('/:id/recalculate-students', async (req, res) => {
  try {
    const ids = await studentRepo.listIdsByTerm(req.params.id);
    if (ids.length === 0) {
      return res.json({ processed: 0, errors: [], fluxoCounts: { A: 0, B: 0, C: 0, INDEFINIDO: 0 }, totalEvents: 0 });
    }
    const r = await generateJourneyEventsBatch(ids);
    const fluxoCounts = { A: 0, B: 0, C: 0, INDEFINIDO: 0 };
    let totalEvents = 0;
    for (const item of r.results) {
      const key = item.fluxo || 'INDEFINIDO';
      fluxoCounts[key] = (fluxoCounts[key] || 0) + 1;
      totalEvents += (item.events || []).length;
    }
    res.json({
      processed: r.results.length,
      errors: r.errors,
      fluxoCounts,
      totalEvents,
    });
  } catch (err) { handleError(res, err); }
});

export default router;
