/**
 * Rate limiter singleton para chamadas ao CRM DataCrazy (campos adicionais).
 * Compartilhado entre cleanup de origem_ativacao e sync de desfechos CAA.
 * Default 20/s — meta ~1000 leads em ~10 min (preflight + origem_ativacao).
 */
import { createRateLimiter } from './rateLimiter.js';

export const DATACRAZY_CRM_RATE_PER_SECOND = Math.max(
  1,
  Math.floor(Number(process.env.DATACRAZY_CRM_RATE_PER_SECOND) || 20)
);

export const datacrazyCrmLimiter = createRateLimiter(DATACRAZY_CRM_RATE_PER_SECOND, 1000);
