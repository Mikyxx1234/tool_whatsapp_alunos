import { Router } from 'express';
import * as settingsRepo from '../repositories/journeySettingsRepository.js';
import { query } from '../db/client.js';

const router = Router();

function handleError(res, err) {
  console.error('[journey-settings]', err.message);
  res.status(err.status || 500).json({ error: err.message || 'Erro interno' });
}

router.get('/', async (req, res) => {
  try {
    const all = await settingsRepo.listAll();
    res.json({ settings: all });
  } catch (err) { handleError(res, err); }
});

router.get('/global', async (_req, res) => {
  try {
    const g = await settingsRepo.getGlobal();
    res.json({ settings: g });
  } catch (err) { handleError(res, err); }
});

router.get('/term/:termId', async (req, res) => {
  try {
    const t = await settingsRepo.getByTerm(req.params.termId);
    res.json({ settings: t });
  } catch (err) { handleError(res, err); }
});

router.put('/global', async (req, res) => {
  try {
    const updated = await settingsRepo.upsertGlobal(req.body || {});
    res.json({ settings: updated });
  } catch (err) { handleError(res, err); }
});

router.put('/term/:termId', async (req, res) => {
  try {
    const updated = await settingsRepo.upsertForTerm(req.params.termId, req.body || {});
    res.json({ settings: updated });
  } catch (err) { handleError(res, err); }
});

/**
 * Preview: dado um set de regras, calcula quantos alunos seriam
 * classificados em cada fluxo. NÃO altera nada.
 */
router.post('/preview-impact', async (req, res) => {
  try {
    const a = Number(req.body?.gap_threshold_a ?? 2);
    const b = Number(req.body?.gap_threshold_b ?? 30);
    const termId = req.body?.term_id || null;

    const params = [a, b];
    let where = `data_matricula is not null
                 and (override_data_inicio_conteudo is not null
                      or data_inicio_conteudo is not null
                      or term_id is not null)`;
    if (termId) {
      params.push(termId);
      where += ` and term_id = $${params.length}`;
    }

    // Calcula GAP usando datas resolvidas: COALESCE(override, term, legado)
    const sql = `
      with resolved as (
        select s.id,
               s.data_matricula as matricula,
               coalesce(
                 s.override_data_inicio_conteudo,
                 t.inicio_conteudo,
                 s.data_inicio_conteudo
               ) as inicio
          from students s
          left join academic_terms t on t.id = s.term_id
         where ${where}
      ),
      with_gap as (
        select id,
               (inicio - matricula) as gap
          from resolved
         where matricula is not null and inicio is not null
      )
      select
        sum(case when gap <= $1 then 1 else 0 end)::int as fluxo_a,
        sum(case when gap > $1 and gap <= $2 then 1 else 0 end)::int as fluxo_b,
        sum(case when gap > $2 then 1 else 0 end)::int as fluxo_c,
        count(*)::int as total
        from with_gap`;
    const { rows } = await query(sql, params);
    const r = rows[0] || { fluxo_a: 0, fluxo_b: 0, fluxo_c: 0, total: 0 };
    res.json({
      thresholds: { a, b },
      term_id: termId,
      fluxoCounts: {
        A: r.fluxo_a || 0,
        B: r.fluxo_b || 0,
        C: r.fluxo_c || 0,
      },
      total_classificable: r.total || 0,
    });
  } catch (err) { handleError(res, err); }
});

export default router;
