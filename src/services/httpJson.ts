import { apiAuthHeaders } from './apiAuth';

/**
 * fetch JSON com mensagens claras para rede/proxy/backend.
 */
export async function fetchJson<T>(  input: string,
  init?: RequestInit & { timeoutMs?: number; timeoutMessage?: string }
): Promise<T> {
  const timeoutMs = init?.timeoutMs ?? 120_000;
  const controller = new AbortController();
  const timer = window.setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(input, {
      ...init,
      signal: controller.signal,
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json',
        ...apiAuthHeaders(),
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
  } catch (err) {
    if (err instanceof Error && err.name === 'AbortError') {
      throw new Error(
        init?.timeoutMessage ||
          'A requisição demorou demais e foi cancelada. Tente de novo ou clique em Atualizar.'
      );
    }
    if (err instanceof TypeError) {
      throw new Error(
        'Não foi possível conectar ao servidor (Failed to fetch). Confira se `npm run dev` está rodando e abra http://localhost:5173/reports'
      );
    }
    throw err;
  } finally {
    window.clearTimeout(timer);
  }
}
