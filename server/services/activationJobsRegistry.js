/** @typedef {{ jobId: string, category: string, status: 'running'|'completed'|'failed'|'cancelled', total: number, processed: number, sent: number, failed_count: number, not_found: number, skipped: number, scanned: number|null, pages: number|null, chunk_index: number|null, chunk_total: number|null, chunk_size: number|null, status_message: string|null, prefetch_done: number|null, prefetch_total: number|null, cancel_requested: boolean, started_at: string, finished_at: string|null, result: object|null, error: string|null }} JobEntry */

/** @type {Map<string, JobEntry>} */
const jobs = new Map();

const CLEANUP_INTERVAL_MS = 5 * 60 * 1000;
const MAX_FINISHED_AGE_MS = 60 * 60 * 1000;
const MAX_RUNNING_AGE_MS = 6 * 60 * 60 * 1000;

const cleanupTimer = setInterval(() => {
  const now = Date.now();
  for (const [id, entry] of jobs) {
    if (entry.finished_at) {
      if (now - new Date(entry.finished_at).getTime() > MAX_FINISHED_AGE_MS) {
        jobs.delete(id);
      }
    } else {
      if (now - new Date(entry.started_at).getTime() > MAX_RUNNING_AGE_MS) {
        jobs.delete(id);
      }
    }
  }
}, CLEANUP_INTERVAL_MS);
cleanupTimer.unref();

/**
 * @param {{ category: string, total: number }} opts
 * @returns {{ jobId: string, entry: JobEntry }}
 */
export function createJob({ category, total }) {
  const jobId = crypto.randomUUID();
  const entry = {
    jobId,
    category,
    status: 'running',
    total: total ?? 0,
    processed: 0,
    sent: 0,
    failed_count: 0,
    not_found: 0,
    skipped: 0,
    scanned: null,
    pages: null,
    chunk_index: null,
    chunk_total: null,
    chunk_size: null,
    status_message: null,
    prefetch_done: null,
    prefetch_total: null,
    cancel_requested: false,
    started_at: new Date().toISOString(),
    finished_at: null,
    result: null,
    error: null,
  };
  jobs.set(jobId, entry);
  return { jobId, entry };
}

/**
 * @param {string} jobId
 * @param {{ total?: number, processed?: number, sent?: number, failed?: number, not_found?: number, skipped?: number, scanned?: number|null, pages?: number|null, chunk_index?: number|null, chunk_total?: number|null, chunk_size?: number|null, status_message?: string|null, prefetch_done?: number|null, prefetch_total?: number|null }} patch
 */
export function updateProgress(jobId, patch) {
  const entry = jobs.get(jobId);
  if (!entry) return;
  if (patch.total != null) entry.total = patch.total;
  if (patch.processed != null) entry.processed = patch.processed;
  if (patch.sent != null) entry.sent = patch.sent;
  if (patch.failed != null) entry.failed_count = patch.failed;
  if (patch.not_found != null) entry.not_found = patch.not_found;
  if (patch.skipped != null) entry.skipped = patch.skipped;
  if (patch.scanned != null) entry.scanned = patch.scanned;
  if (patch.pages != null) entry.pages = patch.pages;
  if (patch.chunk_index != null) entry.chunk_index = patch.chunk_index;
  if (patch.chunk_total != null) entry.chunk_total = patch.chunk_total;
  if (patch.chunk_size != null) entry.chunk_size = patch.chunk_size;
  if (patch.status_message != null) entry.status_message = patch.status_message;
  if (patch.prefetch_done != null) entry.prefetch_done = patch.prefetch_done;
  if (patch.prefetch_total != null) entry.prefetch_total = patch.prefetch_total;
}

/**
 * @param {string} jobId
 * @returns {boolean}
 */
export function requestCancelJob(jobId) {
  const entry = jobs.get(jobId);
  if (!entry || entry.status !== 'running') return false;
  entry.cancel_requested = true;
  return true;
}

/**
 * @param {string} [jobId]
 * @returns {boolean}
 */
export function isJobCancelled(jobId) {
  if (!jobId) return false;
  const entry = jobs.get(jobId);
  return Boolean(entry?.cancel_requested);
}

/**
 * @param {string} jobId
 * @param {{ result?: object, error?: string }} [opts]
 */
export function cancelJob(jobId, opts = {}) {
  const entry = jobs.get(jobId);
  if (!entry) return;
  entry.status = 'cancelled';
  entry.finished_at = new Date().toISOString();
  entry.error = opts.error ?? 'Cancelado pelo operador';
  if (opts.result) entry.result = opts.result;
}

/**
 * @param {string} jobId
 * @param {{ result: object }} opts
 */
export function completeJob(jobId, { result }) {
  const entry = jobs.get(jobId);
  if (!entry) return;
  entry.status = 'completed';
  entry.finished_at = new Date().toISOString();
  entry.result = result;
}

/**
 * @param {string} jobId
 * @param {{ error: string }} opts
 */
export function failJob(jobId, { error }) {
  const entry = jobs.get(jobId);
  if (!entry) return;
  entry.status = 'failed';
  entry.finished_at = new Date().toISOString();
  entry.error = error;
}

/**
 * @param {string} jobId
 * @returns {object|null}
 */
export function getJob(jobId) {
  const entry = jobs.get(jobId);
  if (!entry) return null;
  return {
    jobId: entry.jobId,
    category: entry.category,
    status: entry.status,
    total: entry.total,
    processed: entry.processed,
    sent: entry.sent,
    failed: entry.failed_count,
    not_found: entry.not_found,
    skipped: entry.skipped,
    scanned: entry.scanned,
    pages: entry.pages,
    chunk_index: entry.chunk_index,
    chunk_total: entry.chunk_total,
    chunk_size: entry.chunk_size,
    status_message: entry.status_message,
    prefetch_done: entry.prefetch_done,
    prefetch_total: entry.prefetch_total,
    cancel_requested: entry.cancel_requested,
    started_at: entry.started_at,
    finished_at: entry.finished_at,
    result: entry.result,
    error: entry.error,
  };
}
