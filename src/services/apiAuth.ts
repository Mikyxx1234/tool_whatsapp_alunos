/** Headers para rotas protegidas por APP_API_KEY (opcional em dev). */
export function apiAuthHeaders(): Record<string, string> {
  const key = String(import.meta.env.VITE_APP_API_KEY || '').trim();
  if (!key) return {};
  return { 'x-api-key': key };
}
