/** @typedef {{ jobId: string, category: string, status: 'running'|'completed'|'failed', total: number, processed: number, sent: number, failed_count: number, not_found: number, skipped: number, scanned: number|null, pages: number|null, started_at: string, finished_at: string|null, result: object|null, error: string|null }} JobEntry */

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
 * @param {{ total?: number, processed?: number, sent?: number, failed?: number, not_found?: number, skipped?: number, scanned?: number|null, pages?: number|null }} patch
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
    started_at: entry.started_at,
    finished_at: entry.finished_at,
    result: entry.result,
    error: entry.error,
  };
}
