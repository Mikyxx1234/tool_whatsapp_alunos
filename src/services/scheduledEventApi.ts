import type { ScheduledEventDTO } from './studentApi';

async function jsonFetch<T>(input: string, init?: RequestInit): Promise<T> {
  const response = await fetch(input, {
    ...init,
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/json',
      ...(init?.headers || {}),
    },
  });
  const text = await response.text();
  let data: unknown = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = { raw: text };
  }
  if (!response.ok) {
    const message =
      (data as { error?: string })?.error ||
      `Requisição falhou (${response.status})`;
    throw new Error(message);
  }
  return data as T;
}

export const scheduledEventApi = {
  list({
    status,
    studentId,
    limit = 100,
    offset = 0,
  }: {
    status?: string;
    studentId?: string;
    limit?: number;
    offset?: number;
  } = {}) {
    const qs = new URLSearchParams();
    if (status) qs.set('status', status);
    if (studentId) qs.set('studentId', studentId);
    qs.set('limit', String(limit));
    qs.set('offset', String(offset));
    return jsonFetch<{ events: ScheduledEventDTO[] }>(
      `/api/scheduled-events?${qs.toString()}`
    );
  },
  cancel(id: string, reason?: string) {
    return jsonFetch<{ event: ScheduledEventDTO }>(
      `/api/scheduled-events/${id}/cancel`,
      {
        method: 'POST',
        body: JSON.stringify({ reason }),
      }
    );
  },
  getStatus() {
    return jsonFetch<{
      running: boolean;
      enabled: boolean;
      intervalMs: number;
      batchSize: number;
    }>(`/api/scheduled-events/status`);
  },
  runNow() {
    return jsonFetch(`/api/scheduled-events/run-now`, { method: 'POST' });
  },
};
