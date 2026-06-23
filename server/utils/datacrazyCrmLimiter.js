/**
 * Rate limiter singleton para chamadas ao CRM DataCrazy (campos adicionais).
 * Compartilhado entre cleanup de origem_ativacao e sync de desfechos CAA.
 * Default 15/s — bulk_search no preflight; cache_first serializa buscas.
 */
import { createRateLimiter } from './rateLimiter.js';

export const DATACRAZY_CRM_RATE_PER_SECOND = Math.max(
  1,
  Math.floor(Number(process.env.DATACRAZY_CRM_RATE_PER_SECOND) || 15)
);

export const datacrazyCrmLimiter = createRateLimiter(DATACRAZY_CRM_RATE_PER_SECOND, 1000);
