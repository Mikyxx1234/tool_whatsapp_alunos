import crypto from 'node:crypto';

export function normalizeEmail(value) {
  const s = String(value ?? '').trim().toLowerCase();
  if (s.length < 6 || !s.includes('@')) return '';
  const [local, domain] = s.split('@');
  return local && domain && domain.includes('.') ? s : '';
}

export function normalizePhone(value) {
  let d = String(value ?? '').replace(/\D/g, '');
  if (d.length >= 12 && d.startsWith('55')) d = d.slice(2);
  return d.length >= 10 ? d : '';
}

export function normalizeCpf(value) {
  const d = String(value ?? '').replace(/\D/g, '');
  return d.length === 11 ? d : '';
}

export function normalizeRgm(value) {
  const d = String(value ?? '').replace(/\D/g, '');
  return d.length >= 6 ? d : '';
}

export function stableStringify(value) {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${stableStringify(value[k])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

export function hashObject(value) {
  return crypto.createHash('sha256').update(stableStringify(value)).digest('hex');
}

export function isFilledBusinessValue(value) {
  if (value == null) return false;
  if (Array.isArray(value)) return value.some(isFilledBusinessValue);
  if (typeof value === 'object') return Object.values(value).some(isFilledBusinessValue);
  return String(value).trim() !== '';
}

const TECHNICAL_KEYS = new Set([
  'id',
  'createdAt',
  'updatedAt',
  'created_at',
  'updated_at',
  'lastSyncedAt',
  'last_synced_at',
  'contentHash',
  'content_hash',
]);

/**
 * Flattens business values only. Technical ids/timestamps are ignored so they
 * don't create false-positive data-loss events.
 */
export function collectFilledBusinessPaths(value, prefix = '') {
  const out = new Map();
  if (value == null) return out;
  if (Array.isArray(value)) {
    value.forEach((item, idx) => {
      for (const [path, v] of collectFilledBusinessPaths(item, `${prefix}[${idx}]`)) out.set(path, v);
    });
    return out;
  }
  if (typeof value === 'object') {
    for (const [key, child] of Object.entries(value)) {
      if (TECHNICAL_KEYS.has(key)) continue;
      const next = prefix ? `${prefix}.${key}` : key;
      if (child && typeof child === 'object') {
        for (const [path, v] of collectFilledBusinessPaths(child, next)) out.set(path, v);
      } else if (isFilledBusinessValue(child)) {
        out.set(next, child);
      }
    }
    return out;
  }
  if (prefix && isFilledBusinessValue(value)) out.set(prefix, value);
  return out;
}
