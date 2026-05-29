/**
 * Adiciona `n` dias úteis (inteiros) a uma data.
 *
 * TODO: feriados nacionais/regionais — não implementados.
 * Sábado (dia 6) e domingo (dia 0) são tratados como dias não úteis.
 *
 * @param {Date} date - data de início (não mutada)
 * @param {number} n - número inteiro de dias úteis a adicionar (>= 0)
 * @returns {Date} nova data com n dias úteis somados
 */
export function addBusinessDays(date, n) {
  const result = new Date(date.getTime());
  let added = 0;
  while (added < n) {
    result.setUTCDate(result.getUTCDate() + 1);
    const dow = result.getUTCDay(); // 0 = domingo, 6 = sábado
    if (dow !== 0 && dow !== 6) added++;
  }
  return result;
}
