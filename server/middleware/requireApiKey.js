/**
 * Protege rotas de escrita quando APP_API_KEY está definida no .env.
 * Aceita: Authorization: Bearer <key>  ou  header x-api-key.
 * Se APP_API_KEY não estiver configurada, as rotas permanecem abertas (dev local).
 */

function configuredKey() {
  return String(process.env.APP_API_KEY || '').trim();
}

function extractKey(req) {
  const header = String(req.headers['x-api-key'] || '').trim();
  if (header) return header;
  const auth = String(req.headers.authorization || '').trim();
  if (auth.toLowerCase().startsWith('bearer ')) {
    return auth.slice(7).trim();
  }
  return '';
}

export function requireApiKey(req, res, next) {
  const expected = configuredKey();
  if (!expected) {
    return next();
  }
  const got = extractKey(req);
  if (got && got === expected) {
    return next();
  }
  return res.status(401).json({
    error: 'Não autorizado. Envie APP_API_KEY no header x-api-key ou Authorization: Bearer.',
    code: 'unauthorized',
  });
}

export function isApiKeyEnforced() {
  return Boolean(configuredKey());
}
