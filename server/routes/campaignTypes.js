import { Router } from 'express';
import * as campaignTypeRepo from '../repositories/campaignTypeRepository.js';

const router = Router();

router.get('/', async (_req, res) => {
  try {
    const types = await campaignTypeRepo.listActive();
    res.json({ campaignTypes: types });
  } catch (err) {
    console.error('[GET /api/campaign-types] erro:', err.message);
    res.status(500).json({ error: err.message });
  }
});

export default router;
