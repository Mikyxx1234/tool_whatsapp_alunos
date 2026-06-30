/**
 * Refresh da materialized view `mv_aluno_por_telefone`.
 *
 * A MV consolida nome/rgm/cpf das bases acadêmicas indexado por telefone
 * normalizado (ver migration 037). É usada no Meu Painel para resolver o nome
 * do aluno por telefone quando ele não vem no raw_payload nem nas outras fontes.
 *
 * Dois gatilhos de refresh:
 *   1. Após upload/exclusão de snapshot das bases que alimentam a MV
 *      (matriculados, processos-caa, docs-pendentes, acessos-blackboard) —
 *      disparado em afterBaseUpload (fire-and-forget).
 *   2. Cron diário (default 04:00 UTC) como rede de segurança.
 */
import { query, isDbConfigured } from '../db/client.js';

/** Categorias de base cujo upload deve disparar refresh da MV. */
export const PHONE_LOOKUP_SOURCE_CATEGORIES = new Set([
  'matriculados',
  'processos-caa',
  'docs-pendentes',
  'acessos-blackboard',
]);

let refreshing = false;

/**
 * Roda REFRESH MATERIALIZED VIEW. Tenta CONCURRENTLY (não bloqueia leitores);
 * se a MV nunca foi populada (CONCURRENTLY exige conteúdo prévio), cai no
 * refresh normal. Idempotente e protegido contra execuções concorrentes.
 *
 * @returns {Promise<{ ok: boolean, mode?: string, durationMs?: number, skipped?: boolean, error?: string }>}
 */
export async function refreshAlunoPhoneLookup() {
  if (!isDbConfigured()) return { ok: false, skipped: true };
  if (refreshing) return { ok: true, skipped: true };
  refreshing = true;
  const t0 = Date.now();
  try {
    try {
      await query('refresh materialized view concurrently mv_aluno_por_telefone');
      return { ok: true, mode: 'concurrent', durationMs: Date.now() - t0 };
    } catch (err) {
      // 55000 = object_not_in_prerequisite_state (MV ainda sem dados → CONCURRENTLY falha)
      await query('refresh materialized view mv_aluno_por_telefone');
      return { ok: true, mode: 'full', durationMs: Date.now() - t0 };
    }
  } catch (err) {
    console.error('[aluno-phone-lookup] refresh FAIL:', err.message);
    return { ok: false, error: err.message };
  } finally {
    refreshing = false;
  }
}

/** Dispara refresh em background sem bloquear o caller (ex.: resposta HTTP do upload). */
export function refreshAlunoPhoneLookupBackground() {
  refreshAlunoPhoneLookup().catch((err) =>
    console.error('[aluno-phone-lookup] refresh background FAIL:', err.message)
  );
}

/** Cron diário de refresh como rede de segurança. */
export function startAlunoPhoneLookupCron() {
  if (!isDbConfigured()) return;
  const hourUtc = Math.max(
    0,
    Math.min(23, Math.floor(Number(process.env.ALUNO_PHONE_LOOKUP_REFRESH_HOUR_UTC) || 4))
  );

  function msUntilNextRun() {
    const now = new Date();
    const next = new Date(now);
    next.setUTCHours(hourUtc, 0, 0, 0);
    if (next <= now) next.setUTCDate(next.getUTCDate() + 1);
    return next.getTime() - now.getTime();
  }

  const doRefresh = () => {
    refreshAlunoPhoneLookup()
      .then((r) => {
        if (r.skipped) return;
        if (r.ok) {
          console.log(
            `[aluno-phone-lookup] cron refresh ok (${r.mode}, ${r.durationMs}ms)`
          );
        }
      })
      .catch((err) => console.error('[aluno-phone-lookup] cron FAIL:', err.message));
  };

  const delay = msUntilNextRun();
  console.log(
    `[aluno-phone-lookup] próximo refresh em ${Math.round(delay / 60000)} min (${String(hourUtc).padStart(2, '0')}:00 UTC).`
  );
  const t = setTimeout(() => {
    doRefresh();
    const interval = setInterval(doRefresh, 24 * 60 * 60 * 1000);
    if (typeof interval?.unref === 'function') interval.unref();
  }, delay);
  if (typeof t?.unref === 'function') t.unref();
}
