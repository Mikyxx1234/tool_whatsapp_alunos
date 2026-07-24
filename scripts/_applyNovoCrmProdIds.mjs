/**
 * Carrega data/novo-crm-prod-ids.json em process.env (NOVO_CRM_STAGE_ e FIELD_).
 * Use antes de importar services que leem getNovoCrmStageIds().
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const idsPath = path.join(root, 'data', 'novo-crm-prod-ids.json');

export function applyNovoCrmProdIdsFromFile(filePath = idsPath) {
  if (!fs.existsSync(filePath)) {
    throw new Error(`Arquivo de IDs ausente: ${filePath}. Rode novo-crm-discover-prod-ids.mjs`);
  }
  const raw = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  const stages = raw.stages || {};
  const fields = raw.fields || {};
  for (const [k, v] of Object.entries(stages)) {
    if (k.startsWith('NOVO_CRM_') && v) process.env[k] = String(v);
  }
  for (const [k, v] of Object.entries(fields)) {
    if (k.startsWith('NOVO_CRM_') && v) process.env[k] = String(v);
  }
  // Campo inexistente em PROD — não cair no fallback DEV.
  if (!fields.NOVO_CRM_FIELD_INADIMPLENTE) {
    process.env.NOVO_CRM_FIELD_INADIMPLENTE = '-';
  }
  if (!fields.NOVO_CRM_FIELD_EMAIL) process.env.NOVO_CRM_FIELD_EMAIL = '-';
  if (!fields.NOVO_CRM_FIELD_NASC) process.env.NOVO_CRM_FIELD_NASC = '-';
  return raw;
}
