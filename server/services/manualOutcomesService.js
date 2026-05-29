import path from 'node:path';
import fs from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import * as repo from '../repositories/manualOutcomesRepository.js';
import { findOpenProtocolsByRgm } from '../repositories/caaProtocolsRepository.js';
import { masterKeyFromParts } from '../utils/activationIdentity.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const PROOF_DIR = path.resolve(__dirname, '../uploads/manual_outcomes');

const ALLOWED_MIMES = new Set([
  'image/png',
  'image/jpeg',
  'image/webp',
  'image/gif',
  'application/pdf',
]);

const VALID_CATEGORIES = new Set([
  'docs-pendentes',
  'financeiro',
  'acessos-blackboard',
  'processos-caa',
  'provavel-evasao',
]);

const VALID_OUTCOMES = new Set(['revertido', 'confirmado', 'sem_contato', 'outro']);

function validationError(msg) {
  const err = new Error(msg);
  err.status = 400;
  return err;
}

/**
 * Cria um novo desfecho manual com auto-vinculação de protocolo CAA se aplicável.
 */
export async function createOutcome(body) {
  const category = String(body.category || '').trim();
  const outcome = String(body.outcome || '').trim();
  const consultor_nome = String(body.consultor_nome || '').trim();
  const rgm = body.rgm ? String(body.rgm).trim() : null;
  const cpf = body.cpf ? String(body.cpf).trim() : null;

  if (!VALID_CATEGORIES.has(category)) {
    throw validationError(`category inválida: ${category}`);
  }
  if (!VALID_OUTCOMES.has(outcome)) {
    throw validationError(`outcome inválido: ${outcome}`);
  }
  if (!consultor_nome) {
    throw validationError('consultor_nome é obrigatório');
  }
  if (!rgm && !cpf) {
    throw validationError('Pelo menos um de rgm ou cpf deve estar preenchido');
  }

  let protocolo = body.protocolo ? String(body.protocolo).trim() : null;

  if (category === 'processos-caa' && rgm && !protocolo) {
    const protocols = await findOpenProtocolsByRgm(rgm);
    if (protocols.length === 1) {
      protocolo = protocols[0];
    }
  }

  const master_key = masterKeyFromParts({ rgm: rgm ?? undefined, cpf: cpf ?? undefined });

  return repo.insertOutcome({
    category,
    master_key,
    rgm,
    cpf,
    nome: body.nome ? String(body.nome).trim() : null,
    protocolo,
    outcome,
    motivo: body.motivo ? String(body.motivo).trim() : null,
    notes: body.notes ? String(body.notes).trim() : null,
    consultor_nome,
    occurred_at: body.occurred_at ?? null,
  });
}

/**
 * @param {string} id
 */
export async function getOutcome(id) {
  return repo.findById(id);
}

/**
 * @param {Record<string, unknown>} filters
 */
export async function listOutcomes(filters) {
  return repo.listOutcomes(filters);
}

/**
 * Salva o arquivo de prova no disco e atualiza o registro.
 *
 * @param {string} id
 * @param {Buffer} buffer
 * @param {string} fileName
 * @param {string} mime
 */
export async function saveProof(id, buffer, fileName, mime) {
  if (!ALLOWED_MIMES.has(mime)) {
    const err = new Error(`MIME type não permitido: ${mime}`);
    err.status = 415;
    throw err;
  }

  const existing = await repo.findById(id);
  if (!existing) {
    const err = new Error('Desfecho não encontrado');
    err.status = 404;
    throw err;
  }

  if (existing.proof_path) {
    await fs.unlink(existing.proof_path).catch(() => {});
  }

  const ext = path.extname(fileName) || '';
  const filePath = path.join(PROOF_DIR, `${id}${ext}`);
  await fs.mkdir(PROOF_DIR, { recursive: true });
  await fs.writeFile(filePath, buffer);

  return repo.updateProof(id, {
    proof_path: filePath,
    proof_mime: mime,
    proof_size_bytes: buffer.length,
  });
}

/**
 * Remove só o arquivo de prova (mantém o registro).
 * @param {string} id
 */
export async function removeProof(id) {
  const existing = await repo.findById(id);
  if (!existing) {
    const err = new Error('Desfecho não encontrado');
    err.status = 404;
    throw err;
  }
  if (existing.proof_path) {
    await fs.unlink(existing.proof_path).catch(() => {});
  }
  return repo.clearProof(id);
}

/**
 * Hard delete: apaga registro e arquivo no disco.
 * @param {string} id
 */
export async function deleteOutcome(id) {
  const deleted = await repo.deleteById(id);
  if (!deleted) {
    const err = new Error('Desfecho não encontrado');
    err.status = 404;
    throw err;
  }
  if (deleted.proof_path) {
    await fs.unlink(deleted.proof_path).catch(() => {});
  }
  return deleted;
}
