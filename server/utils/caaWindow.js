import { addBusinessDays } from './businessDays.js';
import { parseFlexibleDate } from './dateParser.js';

/**
 * Resolve T0 e expires_at para um protocolo conforme as configurações de janela.
 *
 * @param {object} p - linha do protocolo com first_seen_at, data_chegada, first_dispatch_at
 * @param {{ caa_janela_t0: string, caa_janela_dias_tipo: string }} cfg
 * @returns {{ t0: Date|null, expires_at: Date|null }}
 */
export function calcJanela(p, cfg) {
  const { caa_janela_t0 = 'primeiro_export', caa_janela_dias_tipo = 'corridos' } = cfg;

  let t0 = null;

  if (caa_janela_t0 === 'data_chegada') {
    t0 = p.data_chegada ? parseFlexibleDate(p.data_chegada) : null;
    if (!t0) t0 = p.first_seen_at ? new Date(p.first_seen_at) : null;
  } else if (caa_janela_t0 === 'primeiro_envio') {
    t0 = p.first_dispatch_at ? new Date(p.first_dispatch_at) : null;
    if (!t0) t0 = p.first_seen_at ? new Date(p.first_seen_at) : null;
  } else {
    // 'primeiro_export' (default)
    t0 = p.first_seen_at ? new Date(p.first_seen_at) : null;
  }

  if (!t0) return { t0: null, expires_at: null };

  const expires_at =
    caa_janela_dias_tipo === 'uteis'
      ? addBusinessDays(t0, 2)
      : new Date(t0.getTime() + 48 * 60 * 60 * 1000);

  return { t0, expires_at };
}

/**
 * Retorna true se a janela ainda está aberta (now < expires_at).
 * @param {object} p
 * @param {{ caa_janela_t0: string, caa_janela_dias_tipo: string }} cfg
 * @param {Date} [now]
 */
export function isWindowOpen(p, cfg, now = new Date()) {
  const { expires_at } = calcJanela(p, cfg);
  if (!expires_at) return true;
  return expires_at.getTime() > now.getTime();
}
