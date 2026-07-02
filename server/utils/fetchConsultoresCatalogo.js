/**
 * Catálogo de consultores acadêmicos — CRM (dcz) ou lista passada pelo cliente.
 * @param {Array<{ username?: string, nome?: string }>|null|undefined} fromClient
 */
export async function fetchConsultoresCatalogo(fromClient) {
  const client = Array.isArray(fromClient) ? fromClient : [];
  if (client.length) {
    return client
      .map((c) => ({
        username: String(c?.username || '').trim() || null,
        nome: String(c?.nome || '').trim(),
      }))
      .filter((c) => c.nome);
  }

  const dczUrl = String(process.env.DCZ_CONSULTORES_URL || '').trim();
  if (!dczUrl) return [];

  try {
    const res = await fetch(dczUrl, { headers: { Accept: 'application/json' } });
    if (!res.ok) return [];
    const data = await res.json();
    if (!Array.isArray(data?.consultores)) return [];
    return data.consultores
      .map((c) => ({
        username: String(c?.username || '').trim() || null,
        nome: String(c?.nome || '').trim(),
      }))
      .filter((c) => c.nome);
  } catch {
    return [];
  }
}
