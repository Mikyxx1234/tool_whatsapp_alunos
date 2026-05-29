/**
 * Parser tolerante para datas que chegam do CSV / formulário.
 *
 * Aceita:
 *   - Date object (passa direto)
 *   - ISO 8601 ("2026-05-06", "2026-05-06T12:00:00Z", etc.)
 *   - "DD/MM/YYYY"     -> data BR
 *   - "DD/MM/YYYY HH:mm[:ss]" -> data BR + hora
 *   - "DD-MM-YYYY"
 *   - "YYYY/MM/DD"
 *   - "" / null / undefined -> null
 *
 * Retorna sempre um Date válido em UTC ou null se inválido.
 */

function pad2(n) {
  return String(n).padStart(2, '0');
}

/**
 * Converte um serial Excel (ex.: 46112 → 03/04/2026) para Date UTC.
 * Considera o "bug do ano bissexto" de 1900: usa 1899-12-30 como base
 * para serials > 60.
 */
export function excelSerialToDate(serial) {
  const n = Number(serial);
  if (!Number.isFinite(n) || n <= 0) return null;
  // base = 1899-12-30 (compensa o bug do Excel para serial 60 = 29/02/1900 inexistente)
  const baseMs = Date.UTC(1899, 11, 30);
  const ms = baseMs + n * 86400000;
  const d = new Date(ms);
  return Number.isNaN(d.getTime()) ? null : d;
}

export function parseFlexibleDate(input) {
  if (input === null || input === undefined || input === '') return null;
  if (input instanceof Date) {
    return Number.isNaN(input.getTime()) ? null : input;
  }
  const str = String(input).trim();
  if (!str) return null;

  // Excel serial puro: número inteiro 5 dígitos (~40000-60000 = 2009-2064)
  if (/^\d{4,6}(\.\d+)?$/.test(str)) {
    const n = Number(str);
    if (n >= 20000 && n <= 80000) {
      const d = excelSerialToDate(n);
      if (d) return d;
    }
  }

  // ISO 8601 (com ou sem hora)
  if (/^\d{4}-\d{2}-\d{2}(T.*)?$/.test(str)) {
    const d = new Date(str);
    return Number.isNaN(d.getTime()) ? null : d;
  }

  // YYYY/MM/DD
  let m = str.match(/^(\d{4})\/(\d{2})\/(\d{2})$/);
  if (m) {
    const d = new Date(`${m[1]}-${m[2]}-${m[3]}T00:00:00Z`);
    return Number.isNaN(d.getTime()) ? null : d;
  }

  // DD/MM/YYYY [HH:mm[:ss]]
  m = str.match(
    /^(\d{1,2})\/(\d{1,2})\/(\d{4})(?:[ T](\d{1,2}):(\d{2})(?::(\d{2}))?)?$/
  );
  if (m) {
    const [, dd, mm, yyyy, hh = '00', mi = '00', ss = '00'] = m;
    const iso = `${yyyy}-${pad2(mm)}-${pad2(dd)}T${pad2(hh)}:${pad2(mi)}:${pad2(ss)}Z`;
    const d = new Date(iso);
    return Number.isNaN(d.getTime()) ? null : d;
  }

  // DD-MM-YYYY
  m = str.match(/^(\d{1,2})-(\d{1,2})-(\d{4})$/);
  if (m) {
    const [, dd, mm, yyyy] = m;
    const d = new Date(`${yyyy}-${pad2(mm)}-${pad2(dd)}T00:00:00Z`);
    return Number.isNaN(d.getTime()) ? null : d;
  }

  // último recurso: tenta o construtor padrão
  const fallback = new Date(str);
  return Number.isNaN(fallback.getTime()) ? null : fallback;
}

/**
 * Converte uma data flexível em string `YYYY-MM-DD` (formato `date` do PG)
 * usando UTC. Retorna null se inválida.
 */
export function toIsoDate(input) {
  const d = parseFlexibleDate(input);
  if (!d) return null;
  return d.toISOString().slice(0, 10);
}

/**
 * Diferença em dias inteiros (b - a). Aceita strings ou Date.
 * Retorna null se algum dos lados for inválido.
 */
export function diffInDays(a, b) {
  const da = parseFlexibleDate(a);
  const db = parseFlexibleDate(b);
  if (!da || !db) return null;
  const MS_PER_DAY = 86400000;
  // zera horas para evitar problemas de timezone na contagem em dias
  const startA = Date.UTC(da.getUTCFullYear(), da.getUTCMonth(), da.getUTCDate());
  const startB = Date.UTC(db.getUTCFullYear(), db.getUTCMonth(), db.getUTCDate());
  return Math.round((startB - startA) / MS_PER_DAY);
}
