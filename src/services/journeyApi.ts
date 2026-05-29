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

export const journeyApi = {
  generateForStudent(studentId: string, recalculateFlow = true) {
    return jsonFetch(`/api/journeys/generate/${studentId}`, {
      method: 'POST',
      body: JSON.stringify({ recalculateFlow }),
    });
  },
  generateBatch(studentIds: string[]) {
    return jsonFetch<{
      processed: number;
      errors: Array<{ studentId: string; error: string }>;
      fluxoCounts: { A: number; B: number; C: number; INDEFINIDO: number };
      totalEvents: number;
    }>(`/api/journeys/generate-batch`, {
      method: 'POST',
      body: JSON.stringify({ studentIds }),
    });
  },
};
