/**
 * Sliding-window rate limiter.
 *
 * Garante que no máximo `maxPerWindow` operações aconteçam dentro de qualquer
 * janela de `windowMs` milissegundos. Quando o teto é atingido, a próxima
 * chamada de `acquire()` espera até o slot mais antigo expirar.
 *
 * Uso típico para respeitar limite Meta WhatsApp (default Cloud API: 80
 * mensagens/s; este projeto usa cap conservador de 60/s, configurável via
 * env `WHATSAPP_MAX_SENDS_PER_SECOND`).
 *
 * Mantém estado em memória — válido para 1 processo Node. Se um dia houver
 * múltiplos workers, trocar por implementação backed por Redis/Postgres.
 *
 * @param {number} maxPerWindow - quantas operações são permitidas por janela
 * @param {number} [windowMs=1000] - duração da janela em ms
 */
export function createRateLimiter(maxPerWindow, windowMs = 1000) {
  const cap = Math.max(1, Math.floor(maxPerWindow));
  /** @type {number[]} timestamps (ms) das últimas operações */
  const recent = [];

  async function acquire() {
    while (true) {
      const now = Date.now();
      while (recent.length > 0 && now - recent[0] >= windowMs) {
        recent.shift();
      }
      if (recent.length < cap) {
        recent.push(now);
        return;
      }
      const waitMs = windowMs - (now - recent[0]) + 1;
      await new Promise((r) => setTimeout(r, waitMs));
    }
  }

  return {
    acquire,
    /** @returns {{ in_window: number, cap: number, window_ms: number }} */
    stats() {
      const now = Date.now();
      const inWindow = recent.filter((t) => now - t < windowMs).length;
      return { in_window: inWindow, cap, window_ms: windowMs };
    },
  };
}
