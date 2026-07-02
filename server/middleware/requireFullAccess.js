/** Admin (role) ou Supervisor Acadêmico (categoria) — espelha activation.js */

function normCat(s) {
  return String(s || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .trim()
    .toLowerCase();
}

export function isSupervisorAcademicoCat(categoriaRaw) {
  return normCat(categoriaRaw) === 'supervisor academico';
}

export function hasFullAccessFromReq(req) {
  const role = String(req.query.role || req.body?.role || '').trim().toLowerCase();
  if (role === 'admin') return true;
  const categoria = req.query.categoria || req.body?.categoria;
  return isSupervisorAcademicoCat(categoria);
}

/** @returns {boolean} false se já respondeu 403 */
export function requireFullAccess(req, res) {
  if (hasFullAccessFromReq(req)) return true;
  res.status(403).json({
    error: 'Apenas admin ou Supervisor Acadêmico.',
    code: 'forbidden',
  });
  return false;
}
