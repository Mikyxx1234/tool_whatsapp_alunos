import { query } from '../db/client.js';
import * as frozenCyclesRepo from '../repositories/frozenCyclesRepository.js';
import * as baseUploadRepo from '../repositories/baseUploadRepository.js';
import * as activationDispatchRepo from '../repositories/activationDispatchRepository.js';
import * as activationResponseRepo from '../repositories/activationResponseRepository.js';
import * as activationOrigemRepo from '../repositories/activationOrigemRepository.js';
import { loadTerms, findTermByMatriculaDate, resolveLimbo } from './termResolverService.js';
import * as journeySettingsRepo from '../repositories/journeySettingsRepository.js';
import { loadBbAccessMap, classifyBbSubgroup } from './bbSubgroupService.js';
import {
  resolveMessageTier,
  resolveTemplateForActivation,
  tierLabel,
} from '../config/activationMessages.js';
import { getActivationTemplateConfig } from './activationTemplateConfigService.js';
import { masterKeyFromActivationItem } from '../utils/activationIdentity.js';
import {
  buildIdentityLookup,
  buildPersonIndexFromSnapshot,
  matchMatriculadoToOtherIndex,
  collectRowIdentities,
  canonicalFromIdentities,
} from './baseComparisonService.js';
import { compareCicloSets, normalizeCiclo, cicloFromRow } from '../utils/cicloFromRow.js';
import * as caaProtocolsRepo from '../repositories/caaProtocolsRepository.js';
import { isWindowOpen, calcJanela } from '../utils/caaWindow.js';
import { pickDisplayRgm, displayRgmFromRematriculaRow, displayRgmFromMatriculadosRow, isValidRematriculaRgm } from '../utils/rgmDisplay.js';
import { repairSiaaRematriculaRow, buildSiaaCelularFromDddAndFone, cpfDigitsFromSiaaRow } from '../utils/siaaRematriculaRepair.js';
import { cpfDigitsFromExcelCell } from '../utils/excelNumericCell.js';
import {
  sanitizeContactEmail,
  sanitizeContactPhone,
} from '../utils/datacrazySearchTerm.js';
import {
  buildMatriculadosRgmMaps,
  rgmFromMatriculadosMaps,
} from '../utils/matriculadosRgmLookup.js';
import {
  datacrazyClient,
  ORIGEM_ATIVACAO_BLOCK_MESSAGE,
} from './datacrazyClient.js';
import { messagingProvider } from './messagingProvider.js';
import { whatsappClient, renderTemplateText } from './whatsappClient.js';
import { buildDispatchNote, shouldCreateDispatchNote } from './datacrazyDispatchNote.js';
import {
  caaCancelamentoSqlWhere,
  isCaaCancelamentoSolicitacao,
} from '../utils/caaRowFilters.js';
import { parseFlexibleDate } from '../utils/dateParser.js';
import { createRateLimiter } from '../utils/rateLimiter.js';
import {
  instituicaoFromRow,
  isRematriculaEmCursoRow,
  rematFinanceiroSubgrupoFromRow,
} from '../utils/rematriculaEligibility.js';

export const URGENCY_HIGH_DAYS = 30;
export const URGENCY_MEDIUM_DAYS = 14;

/**
 * Limiter de envios WhatsApp (cap rígido por segundo).
 * Default 60/s — abaixo do limite Cloud API da Meta (80/s) com folga de segurança.
 * Override via env WHATSAPP_MAX_SENDS_PER_SECOND.
 *
 * Singleton de módulo: compartilhado entre categorias e chamadas paralelas
 * do dispatcher dentro do mesmo processo Node.
 */
const WHATSAPP_SENDS_PER_SECOND = Math.max(
  1,
  Math.floor(Number(process.env.WHATSAPP_MAX_SENDS_PER_SECOND) || 60)
);
const whatsappSendLimiter = createRateLimiter(WHATSAPP_SENDS_PER_SECOND, 1000);

const ACTIVATION_CACHE_TTL_MS = 10 * 60 * 1000;
const ROSTER_CACHE_TTL_MS = ACTIVATION_CACHE_TTL_MS;

/**
 * Cooldown (em horas) entre disparos da mesma pessoa, por categoria.
 * CAA tem cooldown menor (6h) para encaixar 2 disparos por dia dentro da
 * janela CAA de 48h. Demais categorias usam 24h (1x/dia).
 * Substitui o filtro absoluto antigo (1 disparo por pessoa, para sempre).
 */
const COOLDOWN_HOURS_BY_CATEGORY = {
  'processos-caa': 6,
  'docs-pendentes': 24,
  financeiro: 24,
  'acessos-blackboard': 24,
  'provavel-evasao': 24,
  'aguardando-inicio': 24,
  rematricula: 24,
};

function getCooldownHoursForCategory(category) {
  return COOLDOWN_HOURS_BY_CATEGORY[category] ?? 24;
}

/**
 * Retorna true se o master_key foi disparado há menos que `cooldownHours` horas.
 * @param {Map<string, string|Date>} lastSentMap
 * @param {string|null|undefined} masterKey
 * @param {number} cooldownHours
 * @param {number} [now=Date.now()]
 */
function isOnCooldown(lastSentMap, masterKey, cooldownHours, now = Date.now()) {
  if (!masterKey || !lastSentMap) return false;
  const lastRaw = lastSentMap.get(masterKey);
  if (!lastRaw) return false;
  const last = lastRaw instanceof Date ? lastRaw.getTime() : new Date(lastRaw).getTime();
  if (!Number.isFinite(last)) return false;
  return now - last < cooldownHours * 3600 * 1000;
}

export const ACTIVATION_CATEGORIES = /** @type {const} */ ([
  'docs-pendentes',
  'financeiro',
  'provavel-evasao',
  'acessos-blackboard',
  'processos-caa',
  'aguardando-inicio',
  'rematricula',
]);

/** @type {Map<string, { expires: number, data: object }>} */
const activationListCaches = new Map();

/** @type {Map<string, { expires: number, rows: object[], total_unfiltered: number }>} */
const activationRosterCaches = new Map();

/** @type {Map<string, { expires: number, map: Map<string, number> }>} */
const priorCountCaches = new Map();

/** @type {Map<string, { expires: number, map: Map<string, string> }>} */
const lastSentCaches = new Map();

/** @type {Map<string, { expires: number, data: Awaited<ReturnType<typeof buildPersonIndexWithSampleRow>> }>} */
const personIndexCaches = new Map();

/** @type {Map<string, Promise<object[]>>} */
const rosterBuildInFlight = new Map();

export function invalidateActivationRosterCache(category) {
  if (category) {
    for (const key of activationRosterCaches.keys()) {
      if (key.startsWith(`${category}:`)) activationRosterCaches.delete(key);
    }
    for (const key of personIndexCaches.keys()) {
      if (key.startsWith(`${category}:`) || key.startsWith('matriculados:')) {
        personIndexCaches.delete(key);
      }
    }
    priorCountCaches.delete(category);
    lastSentCaches.delete(category);
    return;
  }
  activationRosterCaches.clear();
  priorCountCaches.clear();
  lastSentCaches.clear();
  personIndexCaches.clear();
}

/**
 * @param {string} category
 */
async function getPriorCountMap(category) {
  const cached = priorCountCaches.get(category);
  if (cached && cached.expires > Date.now()) {
    return cached.map;
  }
  const map = await activationDispatchRepo.countAllSentByCategory(category);
  priorCountCaches.set(category, {
    expires: Date.now() + ACTIVATION_CACHE_TTL_MS,
    map,
  });
  return map;
}

/**
 * Map<master_key, lastSentAtISO> com cache. Usado pra expor "tempo desde
 * última ativação" no roster + permitir sort por mais antigo. Mesma TTL
 * dos outros caches do roster.
 * @param {string} category
 * @returns {Promise<Map<string, string>>}
 */
async function getLastSentMap(category) {
  const cached = lastSentCaches.get(category);
  if (cached && cached.expires > Date.now()) {
    return cached.map;
  }
  const map = await activationDispatchRepo.getLastSentAtByMasterKey(category);
  lastSentCaches.set(category, {
    expires: Date.now() + ACTIVATION_CACHE_TTL_MS,
    map,
  });
  return map;
}

/**
 * @param {string} category
 * @param {string} snapshotId
 */
async function buildPersonIndexCached(category, snapshotId, opts = {}) {
  const variant = opts.caaOnlyPending ? 'pend' : 'all';
  const key = `${category}:${snapshotId}:${variant}`;
  const hit = personIndexCaches.get(key);
  if (hit && hit.expires > Date.now()) {
    return hit.data;
  }
  const data = await buildPersonIndexFromSnapshot(category, snapshotId, {
    keepSampleRow: true,
    caaOnlyPending: opts.caaOnlyPending === true,
  });
  personIndexCaches.set(key, { expires: Date.now() + ACTIVATION_CACHE_TTL_MS, data });
  return data;
}

/**
 * @param {string} category
 * @param {string} matSnapId
 * @param {string} otherSnapId
 */
async function buildRosterRowsCached(category, matSnapId, otherSnapId) {
  const rosterCacheKey = `${category}:${matSnapId}:${otherSnapId}`;
  const hit = activationRosterCaches.get(rosterCacheKey);
  if (hit && hit.expires > Date.now()) {
    return { rows: hit.rows, meta: hit.meta };
  }

  let inflight = rosterBuildInFlight.get(rosterCacheKey);
  if (!inflight) {
    inflight = (async () => {
      const storedTemplates = await getActivationTemplateConfig();
      const list = await getIntersectionActivationList(category, { excludeDispatched: false });
      const [countMap, lastSentMap] = await Promise.all([
        getPriorCountMap(category),
        getLastSentMap(category),
      ]);

      const rows = list.items.map((item) => {
        const prior = item.master_key ? countMap.get(item.master_key) || 0 : 0;
        const lastSentRaw = item.master_key ? lastSentMap.get(item.master_key) : null;
        const last_dispatch_at = lastSentRaw
          ? (lastSentRaw instanceof Date ? lastSentRaw.toISOString() : String(lastSentRaw))
          : null;
        const message_tier = resolveMessageTier(prior);
        const template_name = resolveTemplateForActivation(category, prior, storedTemplates);
        return {
          ...item,
          prior_activation_count: prior,
          last_dispatch_at,
          message_tier,
          message_tier_label: tierLabel(message_tier),
          template_name,
          template_configured: Boolean(template_name),
        };
      });

      const meta = {
        skipped_bb_limbo: list.skipped_bb_limbo || 0,
        skipped_ciclo_divergente: list.skipped_ciclo_divergente || 0,
        bb_urgency_counts: list.bb_urgency_counts,
        bb_subgrupo_counts: list.bb_subgrupo_counts,
        remat_subgrupo_counts: list.remat_subgrupo_counts,
        remat_warning: list.remat_warning ?? null,
        intersection_raw: list.intersection_raw ?? null,
        skipped_remat_concluida: list.skipped_remat_concluida ?? null,
        remat_inadimplente_source: list.remat_inadimplente_source ?? null,
      };

      activationRosterCaches.set(rosterCacheKey, {
        expires: Date.now() + ROSTER_CACHE_TTL_MS,
        rows,
        total_unfiltered: rows.length,
        meta,
      });
      return { rows, meta };
    })().finally(() => {
      rosterBuildInFlight.delete(rosterCacheKey);
    });
    rosterBuildInFlight.set(rosterCacheKey, inflight);
  }

  return inflight;
}

/** Evita trabalho pesado em paralelo; só responde se o cache já estiver pronto. */
export async function warmActivationRoster(category) {
  assertActivationCategory(category);
  let matSnap;
  let otherSnapId;
  try {
    ({ matSnap, otherSnapId } = await resolveActivationSnapshotPair(category));
  } catch (err) {
    return { ok: false, category, reason: 'missing_snapshot', error: err.message };
  }
  const rosterCacheKey = `${category}:${matSnap.id}:${otherSnapId}`;
  const hit = activationRosterCaches.get(rosterCacheKey);
  if (hit && hit.expires > Date.now()) {
    return { ok: true, category, already_cached: true };
  }
  if (rosterBuildInFlight.has(rosterCacheKey)) {
    return { ok: true, category, already_building: true };
  }
  void buildRosterRowsCached(category, matSnap.id, otherSnapId).catch((err) => {
    console.error('[activation] warm roster:', err.message);
  });
  return { ok: true, category, warming: true };
}

/** @param {string} category */
export function assertActivationCategory(category) {
  if (!ACTIVATION_CATEGORIES.includes(category)) {
    const err = new Error(`Categoria de ativação inválida: ${category}`);
    err.status = 400;
    throw err;
  }
}

/**
 * Par matriculados + snapshot auxiliar por categoria de ativação.
 * @param {string} category
 */
async function resolveActivationSnapshotPair(category) {
  if (category === 'rematricula') {
    const rematSnap = await baseUploadRepo.getLatestSnapshot('rematricula');
    if (!rematSnap) {
      const err = new Error('Nenhum upload em Rematrícula (SIAA ou Portal de Polos).');
      err.status = 404;
      throw err;
    }
    return { matSnap: rematSnap, otherSnap: rematSnap, otherSnapId: rematSnap.id };
  }

  const matSnap = await baseUploadRepo.getLatestSnapshot('matriculados');
  if (!matSnap) {
    const err = new Error('Nenhum snapshot de matriculados.');
    err.status = 404;
    throw err;
  }
  if (category === 'aguardando-inicio') {
    return { matSnap, otherSnap: null, otherSnapId: 'none' };
  }
  if (category === 'processos-caa') {
    return { matSnap, otherSnap: null, otherSnapId: 'estoque' };
  }
  const otherSnap = await baseUploadRepo.getLatestSnapshot(category);
  if (!otherSnap) {
    const err = new Error(`Nenhum snapshot de ${category}.`);
    err.status = 404;
    throw err;
  }
  return { matSnap, otherSnap, otherSnapId: otherSnap.id };
}

/**
 * Linha da outra base alinhada ao matriculado (para RGM/e-mail da planilha de pendência).
 * @param {{ ids: Set<string>, ciclos: Set<string>, row?: Record<string, unknown> }} matEntry
 * @param {Map<string, { ids: Set<string>, ciclos: Set<string>, row?: Record<string, unknown> }>} otherByCanon
 * @param {Map<string, { ids: Set<string>, ciclos: Set<string>, row?: Record<string, unknown> }[]>} otherLookup
 */
function findAlignedOtherEntry(matEntry, otherByCanon, otherLookup) {
  /** @type {Set<{ ids: Set<string>, ciclos: Set<string>, row?: Record<string, unknown> }>} */
  const candidates = new Set();
  for (const id of matEntry.ids) {
    const list = otherLookup.get(id);
    if (list) for (const e of list) candidates.add(e);
  }
  if (!candidates.size) {
    for (const other of otherByCanon.values()) {
      for (const id of matEntry.ids) {
        if (other.ids.has(id)) candidates.add(other);
      }
    }
  }
  for (const c of candidates) {
    const cmp = compareCicloSets(matEntry.ciclos, c.ciclos);
    if (cmp === 'aligned' || cmp === 'missing') return c;
  }
  return null;
}

/** Primeiro valor bruto que passa no sanitize (ex.: placeholder financeiro → fallback matriculados). */
function coalesceContact(sanitizeFn, ...candidates) {
  for (const raw of candidates) {
    if (raw == null || raw === '') continue;
    const v = sanitizeFn(raw);
    if (v) return v;
  }
  return '';
}

/** @param {Record<string, unknown>} matRow @param {Record<string, unknown>} [otherRow] @param {string} [otherCategory] */
function rowToActivationItem(matRow, otherRow, otherCategory) {
  const nome = String(
    otherRow?.Aluno ?? otherRow?.Nome ?? matRow.Nome ?? matRow.Aluno ?? matRow.nome ?? ''
  ).trim();
  const email = coalesceContact(
    sanitizeContactEmail,
    otherRow?.Email,
    otherRow?.['E-mail'],
    matRow.Email,
    matRow['E-mail']
  );
  const telefone = coalesceContact(
    sanitizeContactPhone,
    otherRow?.Whatsapp,
    otherRow?.Celular,
    otherRow?.['Fone celular'],
    matRow.Whatsapp,
    matRow['Fone celular'],
    matRow.Celular,
    matRow.Telefone
  );
  const rgm = pickDisplayRgm(matRow, otherRow, otherCategory);

  const cpf =
    cpfDigitsFromExcelCell(otherRow?.CPF ?? otherRow?.Cpf ?? '') ||
    cpfDigitsFromExcelCell(matRow.CPF ?? matRow.Cpf ?? '');

  const src = otherRow || matRow;
  return {
    nome,
    email,
    telefone,
    rgm,
    cpf,
    polo: String(src.Polo ?? matRow.Polo ?? '').trim(),
    curso: String(src.Curso ?? matRow.Curso ?? '').trim(),
    ciclo: String(src.Ciclo ?? matRow.Ciclo ?? '').trim(),
    situacao_matricula: String(
      src['Faixa Risco Evasão'] ??
        src['Faixa Risco Evasao'] ??
        src['Situação Matrícula'] ??
        matRow['Situação Matrícula'] ??
        matRow['Situação Atendimento'] ??
        matRow.Situacao ??
        ''
    ).trim(),
    subprocesso_caa: String(src.Subprocesso ?? matRow.Subprocesso ?? '').trim(),
  };
}

/** Ciclo acadêmico no export SIAA (SIT_2026_1 guarda situação, não o ciclo). */
function cicloFromRematriculaRow(row) {
  for (const key of Object.keys(row)) {
    const m = /^SIT_(\d{4})_(\d)$/i.exec(key);
    if (m) return `${m[1]}/${m[2]}`;
  }
  const fromStandard = cicloFromRow(row);
  if (/^\d{4}\/\d$/.test(fromStandard)) return fromStandard;
  return String(process.env.REMAT_CICLO_ORIGEM || '2026/1').trim();
}

/**
 * @param {Record<string, unknown>} rematRow
 * @param {{ lookup?: Map<string, object[]>|null, maps?: object|null }|null} matFallback
 * @returns {Record<string, unknown>|null}
 */
function findMatriculadosRowForRemat(rematRow, matFallback) {
  if (!matFallback?.lookup || !rematRow) return null;
  const ids = collectRowIdentities(rematRow, { category: 'rematricula' });
  for (const id of ids) {
    if (id.startsWith('RGM:')) continue;
    const matches = matFallback.lookup.get(id);
    if (matches?.length && matches[0].row) return matches[0].row;
  }
  return null;
}

/** Linha da base Rematrícula (SIAA / Portal de Polos). */
function rowToRematriculaItem(row, matFallback = null) {
  const matLookup = matFallback?.lookup ?? null;
  const matMaps = matFallback?.maps ?? null;
  const repaired = repairSiaaRematriculaRow(row);
  const matRow = findMatriculadosRowForRemat(repaired, matFallback);
  let rgm = displayRgmFromRematriculaRow(row) || displayRgmFromRematriculaRow(repaired);
  if (!rgm) rgm = pickDisplayRgm(repaired, null, 'rematricula');
  if (!rgm && matLookup) rgm = rgmFromMatriculadosLookup(repaired, matLookup);
  if (!rgm && matMaps) rgm = rgmFromMatriculadosMaps(repaired, matMaps);
  const nome = String(repaired.NOME ?? repaired.Nome ?? repaired.Aluno ?? repaired.nome ?? '').trim();
  const email = coalesceContact(
    sanitizeContactEmail,
    repaired.E_MAIL,
    repaired.Email,
    repaired['E-mail'],
    matRow?.Email,
    matRow?.['E-mail'],
    matRow?.E_MAIL
  );
  const telefone = coalesceContact(
    sanitizeContactPhone,
    repaired.FONE_CEL,
    repaired.TELEFONE_CEL,
    buildSiaaCelularFromDddAndFone(repaired),
    matRow?.Whatsapp,
    matRow?.['Fone celular'],
    matRow?.Celular,
    matRow?.Telefone
  );
  const cpfDigits =
    cpfDigitsFromSiaaRow(repaired) ||
    cpfDigitsFromExcelCell(matRow?.CPF ?? matRow?.Cpf ?? matRow?.cpf ?? '');
  return {
    nome,
    email,
    telefone,
    rgm,
    cpf: cpfDigits,
    polo: String(repaired.NOME_POLO ?? repaired.Polo ?? '').trim(),
    curso: String(repaired.DES_CURS ?? repaired.Curso ?? '').trim(),
    ciclo: cicloFromRematriculaRow(repaired),
    situacao_matricula: String(
      repaired.SIT_ATUAL ?? repaired.Sit_Atual ?? repaired['Situação Matrícula'] ?? repaired.Situacao ?? ''
    ).trim(),
    subprocesso_caa: '',
  };
}

/**
 * @param {Record<string, unknown>} rematRow
 * @param {Map<string, object[]>|null} matLookup
 */
function rgmFromMatriculadosLookup(rematRow, matLookup) {
  if (!matLookup) return '';
  const ids = collectRowIdentities(rematRow, { category: 'rematricula' });
  for (const id of ids) {
    if (id.startsWith('RGM:')) continue;
    const matches = matLookup.get(id);
    if (!matches?.length) continue;
    for (const matEntry of matches) {
      for (const matId of matEntry.ids) {
        if (matId.startsWith('RGM:')) {
          const canon = matId.slice(4);
          if (isValidRematriculaRgm(canon)) return canon;
        }
      }
      if (matEntry.row) {
        const rgm = displayRgmFromMatriculadosRow(matEntry.row);
        if (isValidRematriculaRgm(rgm)) return rgm;
      }
    }
  }
  return '';
}

/** Lookup matriculados: índice de identidade + mapas diretos (CPF/e-mail/nome). */
async function buildMatriculadosFallbackForRemat() {
  const snap = await baseUploadRepo.getLatestSnapshot('matriculados');
  if (!snap) return { lookup: null, maps: null };
  const [index, maps] = await Promise.all([
    buildPersonIndexFromSnapshot('matriculados', snap.id),
    buildMatriculadosRgmMaps(snap.id),
  ]);
  return {
    lookup: buildIdentityLookup(index.byCanon),
    maps,
  };
}

/**
 * @param {object|null} term
 * @param {Date} today
 * @returns {{ urgency: 'alta'|'media'|'normal'|'limbo'|'sem_turma', dias_apos_inicio: number|null }}
 */
function computeBbUrgency(term, today) {
  if (!term?.inicio_conteudo) return { urgency: 'sem_turma', dias_apos_inicio: null };
  const raw = String(term.inicio_conteudo || '').trim();
  const inicioDate = parseFlexibleDate(raw.includes('T') ? raw : `${raw}T00:00:00Z`);
  if (!inicioDate) return { urgency: 'sem_turma', dias_apos_inicio: null };
  const inicio = inicioDate.getTime();
  const ambientacaoMs = term.tem_ambientacao ? Number(term.dias_ambientacao || 0) * 86400000 : 0;
  const efetivoMs = inicio - ambientacaoMs;
  const diff = today.getTime() - efetivoMs;
  if (diff < 0) return { urgency: 'limbo', dias_apos_inicio: Math.ceil(diff / 86400000) };
  const dias = Math.floor(diff / 86400000);
  if (dias >= URGENCY_HIGH_DAYS) return { urgency: 'alta', dias_apos_inicio: dias };
  if (dias >= URGENCY_MEDIUM_DAYS) return { urgency: 'media', dias_apos_inicio: dias };
  return { urgency: 'normal', dias_apos_inicio: dias };
}

/**
 * Constrói o índice de pessoas da fila CAA a partir do estoque acumulado em
 * `caa_protocols` (status='open'), aplicando o filtro de janela configurado.
 * Substitui o buildPersonIndexFromSnapshot para a categoria processos-caa.
 */
async function buildCaaPendingIndexFromProtocols() {
  const [openRows, settings] = await Promise.all([
    caaProtocolsRepo.listOpenProtocolsByRgm(),
    journeySettingsRepo.resolveForTerm(null),
  ]);
  const cfg = {
    caa_janela_t0: settings?.caa_janela_t0 ?? 'primeiro_export',
    caa_janela_dias_tipo: settings?.caa_janela_dias_tipo ?? 'corridos',
  };
  const now = new Date();

  /** @type {Map<string, import('./baseComparisonService.js').PersonIndexEntry>} */
  const byCanon = new Map();
  let skipped_window_expired = 0;

  for (const p of openRows) {
    if (!isWindowOpen(p, cfg, now)) {
      skipped_window_expired += 1;
      continue;
    }
    const row = p.data && typeof p.data === 'object' ? p.data : {
      Protocolo: p.protocolo,
      RGM: p.rgm,
      CPF: p.cpf,
      Aluno: p.nome,
      Email: p.email,
      Celular: p.telefone,
      Polo: p.polo,
      Curso: p.curso,
      Subprocesso: p.subprocesso,
      'Data Chegada': p.data_chegada,
      'Data Previsão': p.data_previsao,
      'Situação Atendimento': p.situacao_atendimento_raw,
      'Situação Deferimento': p.situacao_deferimento_raw,
    };
    const ids = collectRowIdentities(row, { category: 'processos-caa' });
    if (ids.size === 0) continue;
    const canon = canonicalFromIdentities(ids);
    if (!canon) continue;
    const ciclo = cicloFromRow(row);
    const cur = byCanon.get(canon);
    if (!cur) {
      const entry = { ids: new Set(ids), ciclos: new Set(), row };
      if (ciclo) entry.ciclos.add(ciclo);
      byCanon.set(canon, entry);
    } else {
      for (const id of ids) cur.ids.add(id);
      if (ciclo) cur.ciclos.add(ciclo);
    }
  }

  return {
    byCanon,
    skipped: 0,
    rowCount: openRows.length,
    rowCountTotal: openRows.length,
    rowFilterActive: true,
    skipped_window_expired,
  };
}

/**
 * Matriculados que também estão na outra base (interseção).
 * @param {string} category
 * @param {{ excludeDispatched?: boolean }} [opts] — padrão: true (não repetir mesma ativação)
 */
export async function getIntersectionActivationList(category, opts = {}) {
  const excludeDispatched = opts.excludeDispatched !== false;
  assertActivationCategory(category);

  if (category === 'rematricula') {
    const rematSnap = await baseUploadRepo.getLatestSnapshot('rematricula');
    if (!rematSnap) {
      const err = new Error('Nenhum upload em Rematrícula (SIAA ou Portal de Polos).');
      err.status = 404;
      throw err;
    }
    return _buildRematriculaList(category, rematSnap, excludeDispatched);
  }

  const matSnap = await baseUploadRepo.getLatestSnapshot('matriculados');
  if (!matSnap) {
    const err = new Error('Nenhum snapshot de matriculados.');
    err.status = 404;
    throw err;
  }

  // aguardando-inicio não tem export próprio — só usa matriculados + turmas.
  if (category === 'aguardando-inicio') {
    return _buildAguardandoInicioList(category, matSnap, excludeDispatched);
  }

  // CAA usa estoque acumulado de caa_protocols — não precisa de snapshot próprio.
  const otherSnap = category === 'processos-caa'
    ? null
    : await baseUploadRepo.getLatestSnapshot(category);
  if (!otherSnap && category !== 'processos-caa') {
    const err = new Error(`Nenhum snapshot de ${category}.`);
    err.status = 404;
    throw err;
  }

  const cacheKey = `${category}:${matSnap.id}:${category === 'processos-caa' ? 'estoque' : otherSnap.id}:${excludeDispatched ? 'ex' : 'all'}`;
  const cached = activationListCaches.get(cacheKey);
  if (cached && cached.expires > Date.now()) {
    return cached.data;
  }

  const [matIndex, otherIndex] = await Promise.all([
    buildPersonIndexCached('matriculados', matSnap.id),
    category === 'processos-caa'
      ? buildCaaPendingIndexFromProtocols()
      : buildPersonIndexCached(category, otherSnap.id),
  ]);
  const otherLookup = buildIdentityLookup(otherIndex.byCanon);

  /** BB: quem está no export no mesmo ciclo já acessou — fila = sem linha alinhada ao ciclo. */
  const matriculadosSemNaOutraBase = category === 'acessos-blackboard';
  const lastSentMap = await activationDispatchRepo.getLastSentAtByMasterKey(category);
  const cooldownHours = getCooldownHoursForCategory(category);
  const cooldownNow = Date.now();

  // BB: alunos cuja turma ainda não começou ficam de fora (regra "limbo").
  const filterBbLimbo = category === 'acessos-blackboard';
  const terms = filterBbLimbo ? await loadTerms() : [];
  const today = new Date();

  // BB: mapa de acessos e thresholds para classificação de subgrupo.
  let bbAccessMap = null;
  let bbThresholds = null;
  if (category === 'acessos-blackboard') {
    const [accessMap, globalSettings] = await Promise.all([
      loadBbAccessMap(),
      journeySettingsRepo.resolveForTerm(null),
    ]);
    bbAccessMap = accessMap;
    bbThresholds = {
      bb_nao_acessa_dias: globalSettings?.bb_nao_acessa_dias ?? 14,
      bb_acessou_pouco_minutos: globalSettings?.bb_acessou_pouco_minutos ?? 60,
      bb_acessou_pouco_interacoes: globalSettings?.bb_acessou_pouco_interacoes ?? 10,
    };
  }

  /** @type {(ReturnType<typeof rowToActivationItem> & { master_key?: string })[]} */
  const items = [];
  const seenMaster = new Set();
  let skipped_already_dispatched = 0;
  let skipped_duplicate_key = 0;
  let skipped_ciclo_divergente = 0;
  let skipped_bb_limbo = 0;
  let intersection_raw = 0;

  for (const entry of matIndex.byCanon.values()) {
    const matchKind = matchMatriculadoToOtherIndex(entry, otherIndex.byCanon, otherLookup);
    const alignedHit = matchKind === 'aligned';
    if (matchKind === 'cross_cycle') skipped_ciclo_divergente += 1;
    if (matriculadosSemNaOutraBase ? alignedHit : !alignedHit) continue;
    intersection_raw += 1;
    const row = entry.row;
    if (!row) continue;

    let bbUrgency = 'sem_turma';
    let bbDiasAposInicio = null;
    let bbTermCodigo = null;
    let bbSubgrupo = null;

    if (filterBbLimbo) {
      const dataMat =
        row['Data Matrícula'] ??
        row['Data Matricula'] ??
        row['Data da Matricula'] ??
        row['Data de Matrícula'];
      const term = dataMat && terms.length > 0 ? findTermByMatriculaDate(terms, dataMat) : null;
      const { urgency, dias_apos_inicio } = computeBbUrgency(term, today);
      if (urgency === 'limbo') {
        skipped_bb_limbo += 1;
        continue;
      }
      bbUrgency = urgency;
      bbDiasAposInicio = dias_apos_inicio;
      bbTermCodigo = term?.codigo ?? null;
    }

    const otherEntry = findAlignedOtherEntry(entry, otherIndex.byCanon, otherLookup);
    const item = rowToActivationItem(row, otherEntry?.row, category);
    const master_key = masterKeyFromActivationItem(item) ?? undefined;

    // BB subgrupo: classifica antes de fazer dedup para não perder contagem.
    if (category === 'acessos-blackboard' && bbAccessMap && bbThresholds) {
      const canonRgm = master_key ? master_key.replace(/^RGM:/, '') : '';
      const accessRow = canonRgm ? bbAccessMap.get(canonRgm) ?? null : null;
      bbSubgrupo = classifyBbSubgroup({ accessRow, thresholds: bbThresholds, today });
      if (bbSubgrupo === 'ok') {
        // Aluno com acesso suficiente — não entra na fila.
        continue;
      }
    }

    if (master_key) {
      if (seenMaster.has(master_key)) {
        skipped_duplicate_key += 1;
        continue;
      }
      seenMaster.add(master_key);
      if (isOnCooldown(lastSentMap, master_key, cooldownHours, cooldownNow)) {
        skipped_already_dispatched += 1;
        if (excludeDispatched) continue;
      }
    }
    const baseItem = master_key ? { ...item, master_key } : item;
    if (category === 'acessos-blackboard') {
      items.push({
        ...baseItem,
        bb_urgency: bbUrgency,
        bb_dias_apos_inicio: bbDiasAposInicio,
        bb_term_codigo: bbTermCodigo,
        bb_subgrupo: bbSubgrupo,
      });
    } else {
      items.push(baseItem);
    }
  }

  if (category === 'processos-caa' && items.length) {
    const [openRows, janelaSettings] = await Promise.all([
      caaProtocolsRepo.listOpenProtocolsByRgm(),
      journeySettingsRepo.resolveForTerm(null),
    ]);
    const janelaCfg = {
      caa_janela_t0: janelaSettings?.caa_janela_t0 ?? 'primeiro_export',
      caa_janela_dias_tipo: janelaSettings?.caa_janela_dias_tipo ?? 'corridos',
    };
    /** @type {Map<string, { t0: Date|null, expires_at: Date|null }>} */
    const windowByRgm = new Map();
    for (const p of openRows) {
      if (!p.rgm) continue;
      const w = calcJanela(p, janelaCfg);
      const prev = windowByRgm.get(p.rgm);
      if (!prev) {
        windowByRgm.set(p.rgm, w);
      } else if (w.expires_at && (!prev.expires_at || w.expires_at < prev.expires_at)) {
        windowByRgm.set(p.rgm, w);
      }
    }
    for (const it of items) {
      const w = it.rgm ? windowByRgm.get(it.rgm) : null;
      it.caa_janela = w
        ? {
            t0: w.t0 ? w.t0.toISOString() : null,
            expires_at: w.expires_at ? w.expires_at.toISOString() : null,
            t0_source: janelaCfg.caa_janela_t0,
            dias_tipo: janelaCfg.caa_janela_dias_tipo,
          }
        : null;
    }
  }

  const SUBGRUPO_ORDER = { podia_e_nao_acessou: 0, nao_acessa_faz_tempo: 1, acessou_pouco: 2 };
  const URGENCY_ORDER = { alta: 0, media: 1, normal: 2, sem_turma: 3 };
  items.sort((a, b) => {
    if (category === 'acessos-blackboard') {
      const sa = SUBGRUPO_ORDER[a.bb_subgrupo ?? 'acessou_pouco'] ?? 9;
      const sb = SUBGRUPO_ORDER[b.bb_subgrupo ?? 'acessou_pouco'] ?? 9;
      if (sa !== sb) return sa - sb;
      const ua = URGENCY_ORDER[a.bb_urgency ?? 'sem_turma'] ?? 9;
      const ub = URGENCY_ORDER[b.bb_urgency ?? 'sem_turma'] ?? 9;
      if (ua !== ub) return ua - ub;
      const da = a.bb_dias_apos_inicio ?? -1;
      const db = b.bb_dias_apos_inicio ?? -1;
      if (da !== db) return db - da;
    }
    if (category === 'processos-caa') {
      const ea = a.caa_janela?.expires_at
        ? new Date(a.caa_janela.expires_at).getTime()
        : Number.POSITIVE_INFINITY;
      const eb = b.caa_janela?.expires_at
        ? new Date(b.caa_janela.expires_at).getTime()
        : Number.POSITIVE_INFINITY;
      if (ea !== eb) return ea - eb;
    }
    return a.nome.localeCompare(b.nome, 'pt-BR');
  });

  const bb_urgency_counts = category === 'acessos-blackboard' ? {
    alta: items.filter((i) => i.bb_urgency === 'alta').length,
    media: items.filter((i) => i.bb_urgency === 'media').length,
    normal: items.filter((i) => i.bb_urgency === 'normal').length,
    sem_turma: items.filter((i) => i.bb_urgency === 'sem_turma').length,
  } : undefined;

  const bb_subgrupo_counts = category === 'acessos-blackboard' ? {
    podia_e_nao_acessou: items.filter((i) => i.bb_subgrupo === 'podia_e_nao_acessou').length,
    nao_acessa_faz_tempo: items.filter((i) => i.bb_subgrupo === 'nao_acessa_faz_tempo').length,
    acessou_pouco: items.filter((i) => i.bb_subgrupo === 'acessou_pouco').length,
  } : undefined;

  const result = {
    category,
    total: items.length,
    items,
    intersection_raw,
    already_dispatched_in_db: lastSentMap.size,
    cooldown_hours: cooldownHours,
    skipped_already_dispatched,
    skipped_duplicate_key,
    skipped_ciclo_divergente,
    skipped_bb_limbo,
    bb_urgency_counts,
    bb_subgrupo_counts,
    exclude_dispatched: excludeDispatched,
    matriculados_snapshot_id: matSnap.id,
    other_snapshot_id: otherSnap?.id ?? null,
    generated_at: new Date().toISOString(),
  };

  activationListCaches.set(cacheKey, {
    expires: Date.now() + ACTIVATION_CACHE_TTL_MS,
    data: result,
  });

  return result;
}

/**
 * Fila "aguardando-inicio": alunos matriculados cuja turma ainda não começou (limbo).
 * Não cruza com nenhum export externo.
 */
async function _buildAguardandoInicioList(category, matSnap, excludeDispatched) {
  const cacheKey = `${category}:${matSnap.id}:none:${excludeDispatched ? 'ex' : 'all'}`;
  const cached = activationListCaches.get(cacheKey);
  if (cached && cached.expires > Date.now()) return cached.data;

  const [matIndex, lastSentMap, terms] = await Promise.all([
    buildPersonIndexCached('matriculados', matSnap.id),
    activationDispatchRepo.getLastSentAtByMasterKey(category),
    loadTerms(),
  ]);
  const cooldownHours = getCooldownHoursForCategory(category);
  const cooldownNow = Date.now();
  const today = new Date();

  /** @type {Array<object>} */
  const items = [];
  const seenMaster = new Set();
  let skipped_already_dispatched = 0;
  let skipped_duplicate_key = 0;

  for (const entry of matIndex.byCanon.values()) {
    const row = entry.row;
    if (!row) continue;
    const dataMat =
      row['Data Matrícula'] ??
      row['Data Matricula'] ??
      row['Data da Matricula'] ??
      row['Data de Matrícula'];
    const { limbo, daysUntilStart, term } = resolveLimbo(terms, dataMat, today);
    if (!limbo) continue;

    const item = rowToActivationItem(row, null, category);
    const master_key = masterKeyFromActivationItem(item) ?? undefined;

    if (master_key) {
      if (seenMaster.has(master_key)) {
        skipped_duplicate_key += 1;
        continue;
      }
      seenMaster.add(master_key);
      if (isOnCooldown(lastSentMap, master_key, cooldownHours, cooldownNow)) {
        skipped_already_dispatched += 1;
        if (excludeDispatched) continue;
      }
    }

    const baseItem = master_key ? { ...item, master_key } : item;
    items.push({
      ...baseItem,
      dias_ate_inicio: daysUntilStart ?? null,
      bb_term_codigo: term?.codigo ?? null,
    });
  }

  items.sort((a, b) => {
    const da = a.dias_ate_inicio ?? 9999;
    const db = b.dias_ate_inicio ?? 9999;
    if (da !== db) return da - db;
    return a.nome.localeCompare(b.nome, 'pt-BR');
  });

  const result = {
    category,
    total: items.length,
    items,
    intersection_raw: items.length,
    already_dispatched_in_db: lastSentMap.size,
    cooldown_hours: cooldownHours,
    skipped_already_dispatched,
    skipped_duplicate_key,
    skipped_ciclo_divergente: 0,
    skipped_bb_limbo: 0,
    exclude_dispatched: excludeDispatched,
    matriculados_snapshot_id: matSnap.id,
    other_snapshot_id: null,
    generated_at: new Date().toISOString(),
  };

  activationListCaches.set(cacheKey, {
    expires: Date.now() + ACTIVATION_CACHE_TTL_MS,
    data: result,
  });

  return result;
}

/**
 * Fila rematrícula: upload SIAA ou Portal de Polos — SIT_ATUAL=EM CURSO;
 * adimplente/inadimplente via SIT_FINAN (ou inadimplente no Portal).
 */
async function _buildRematriculaList(category, rematSnap, excludeDispatched) {
  const rematSource = rematSnap?.source ?? null;
  const cacheKey = `${category}:${rematSnap.id}:${excludeDispatched ? 'ex' : 'all'}`;
  const cached = activationListCaches.get(cacheKey);
  if (cached && cached.expires > Date.now()) return cached.data;

  const lastSentMap = await activationDispatchRepo.getLastSentAtByMasterKey(category);
  const cooldownHours = getCooldownHoursForCategory(category);
  const cooldownNow = Date.now();

  /** @type {Array<object>} */
  const items = [];
  const seenMaster = new Set();
  let skipped_already_dispatched = 0;
  let skipped_duplicate_key = 0;
  let intersection_raw = 0;

  const matFallback = await buildMatriculadosFallbackForRemat();

  await baseUploadRepo.forEachRowDataForSnapshot('rematricula', rematSnap.id, (row) => {
    if (!isRematriculaEmCursoRow(row)) return;
    intersection_raw += 1;

    const remat_subgrupo = rematFinanceiroSubgrupoFromRow(row);
    const item = rowToRematriculaItem(row, matFallback);
    const master_key = masterKeyFromActivationItem(item) ?? undefined;

    if (master_key) {
      if (seenMaster.has(master_key)) {
        skipped_duplicate_key += 1;
        return;
      }
      seenMaster.add(master_key);
      if (isOnCooldown(lastSentMap, master_key, cooldownHours, cooldownNow)) {
        skipped_already_dispatched += 1;
        if (excludeDispatched) return;
      }
    }

    items.push({
      ...(master_key ? { ...item, master_key } : item),
      instituicao: instituicaoFromRow(row),
      remat_subgrupo,
    });
  });

  const SUBGRUPO_ORDER = { inadimplente: 0, adimplente: 1 };
  items.sort((a, b) => {
    const sa = SUBGRUPO_ORDER[a.remat_subgrupo] ?? 9;
    const sb = SUBGRUPO_ORDER[b.remat_subgrupo] ?? 9;
    if (sa !== sb) return sa - sb;
    return a.nome.localeCompare(b.nome, 'pt-BR');
  });

  const remat_subgrupo_counts = {
    adimplente: items.filter((i) => i.remat_subgrupo === 'adimplente').length,
    inadimplente: items.filter((i) => i.remat_subgrupo === 'inadimplente').length,
  };

  const result = {
    category,
    total: items.length,
    items,
    intersection_raw,
    already_dispatched_in_db: lastSentMap.size,
    cooldown_hours: cooldownHours,
    skipped_already_dispatched,
    skipped_duplicate_key,
    skipped_ciclo_divergente: 0,
    skipped_bb_limbo: 0,
    skipped_remat_concluida: 0,
    remat_subgrupo_counts,
    exclude_dispatched: excludeDispatched,
    matriculados_snapshot_id: null,
    other_snapshot_id: rematSnap.id,
    remat_warning: null,
    remat_inadimplente_source: rematSource,
    generated_at: new Date().toISOString(),
  };

  activationListCaches.set(cacheKey, {
    expires: Date.now() + ACTIVATION_CACHE_TTL_MS,
    data: result,
  });

  return result;
}

export async function getDocsPendentesActivationList() {
  return getIntersectionActivationList('docs-pendentes');
}

export function invalidateActivationListCache(category) {
  if (category) {
    for (const key of activationListCaches.keys()) {
      if (key.startsWith(`${category}:`)) activationListCaches.delete(key);
    }
    invalidateActivationRosterCache(category);
    return;
  }
  activationListCaches.clear();
  invalidateActivationRosterCache();
}

/**
 * Marca pessoas como já ativadas nesta categoria (outras categorias não são afetadas).
 * @param {string} category
 * @param {{ masterKeys?: string[], markAllEligible?: boolean }} opts
 */
export async function markActivationDispatched(category, opts = {}) {
  assertActivationCategory(category);
  let keys = opts.masterKeys || [];
  if (opts.markAllEligible) {
    const list = await getIntersectionActivationList(category, { excludeDispatched: true });
    keys = list.items.map((i) => i.master_key).filter(Boolean);
  }
  let registered = 0;
  for (const key of keys) {
    await activationDispatchRepo.recordDispatchEvent({
      category,
      masterKey: key,
      status: 'sent',
      channel: 'manual',
    });
    registered += 1;
  }
  invalidateActivationListCache(category);
  return { category, registered, keys_submitted: keys.length };
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** @typedef {'all'|'first'|'repeat'|'fifth'} ActivationStageFilter */

/**
 * @param {number} priorCount — vezes já ativado nesta categoria
 * @param {ActivationStageFilter} stage
 */
export function matchesActivationStageFilter(priorCount, stage) {
  if (!stage || stage === 'all') return true;
  const tier = resolveMessageTier(priorCount);
  if (stage === 'first') return tier === 'first';
  if (stage === 'repeat') return tier === 'repeat';
  if (stage === 'fifth') return tier === 'fifth';
  return true;
}

/**
 * @param {string} raw
 * @returns {ActivationStageFilter}
 */
export function parseActivationStageFilter(raw) {
  const s = String(raw || '')
    .trim()
    .toLowerCase();
  if (s === 'first' || s === '1') return 'first';
  if (s === 'repeat' || s === '2' || s === '3' || s === '4' || s === 'reativacao') {
    return 'repeat';
  }
  if (s === 'fifth' || s === '5plus' || s === '5+' || s === '5') return 'fifth';
  return 'all';
}

/**
 * Normaliza o param `sort` recebido da rota.
 * 'last_dispatch_oldest' → mais antigos primeiro (e esconde nunca-ativados)
 * 'last_dispatch_newest' → mais recentes primeiro (e esconde nunca-ativados)
 * default → null (ordem natural do snapshot)
 * @param {unknown} raw
 * @returns {'last_dispatch_oldest'|'last_dispatch_newest'|null}
 */
function parseRosterSort(raw) {
  const v = String(raw || '').toLowerCase();
  if (v === 'last_dispatch_oldest' || v === 'last_dispatch_newest') return v;
  return null;
}

function normalizeRosterSearchText(value) {
  return String(value || '')
    .trim()
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '');
}

/** Busca por nome, e-mail, RGM, CPF, polo ou telefone (case/acento insensitive). */
function matchesRosterSearch(row, query) {
  const q = normalizeRosterSearchText(query);
  if (!q) return true;
  const parts = [
    row.nome,
    row.email,
    row.telefone,
    row.rgm,
    row.cpf,
    row.polo,
    row.curso,
    row.master_key,
  ]
    .filter(Boolean)
    .map(normalizeRosterSearchText);
  const hay = parts.join(' ');
  if (hay.includes(q)) return true;
  const qDigits = q.replace(/\D/g, '');
  if (qDigits.length >= 3) {
    const rgmDigits = String(row.rgm || '').replace(/\D/g, '');
    const cpfDigits = String(row.cpf || '').replace(/\D/g, '');
    const telDigits = String(row.telefone || '').replace(/\D/g, '');
    if (
      (rgmDigits && rgmDigits.includes(qDigits)) ||
      (cpfDigits && cpfDigits.includes(qDigits)) ||
      (telDigits && telDigits.includes(qDigits))
    ) {
      return true;
    }
  }
  return false;
}

/**
 * Aplica sort por última ativação e esconde leads nunca-ativados.
 * Decisão (UX): quando o usuário ordena por "última ativação", leads
 * sem prior_activation_count somem (não faz sentido ordenar por data
 * que não existe; e o user pediu pra focar em reativação).
 * @param {object[]} rows
 * @param {'last_dispatch_oldest'|'last_dispatch_newest'|null} sort
 * @returns {{ rows: object[], hidden_count: number }}
 */
function applyRosterSort(rows, sort) {
  if (!sort) return { rows, hidden_count: 0 };
  const before = rows.length;
  const filtered = rows.filter((r) => (r.prior_activation_count || 0) > 0);
  const hidden_count = before - filtered.length;
  const asc = sort === 'last_dispatch_oldest';
  filtered.sort((a, b) => {
    const at = a.last_dispatch_at ? Date.parse(a.last_dispatch_at) : (asc ? Infinity : -Infinity);
    const bt = b.last_dispatch_at ? Date.parse(b.last_dispatch_at) : (asc ? Infinity : -Infinity);
    return asc ? at - bt : bt - at;
  });
  return { rows: filtered, hidden_count };
}

/**
 * Lista de matriculados na fila de ativação com contagem e template sugerido.
 */
export async function getActivationRoster(category, opts = {}) {
  assertActivationCategory(category);
  const stageFilter = parseActivationStageFilter(opts.activationStage);
  const sortMode = parseRosterSort(opts.sort);
  const responseFilter = (() => {
    const v = String(opts.responseFilter || 'all').toLowerCase();
    return v === 'responded' || v === 'not_responded' ? v : 'all';
  })();

  if (opts.countOnly) {
    const list = await getIntersectionActivationList(category, {
      excludeDispatched: opts.excludeDispatched !== false,
    });
    return {
      category,
      total: list.total,
      total_unfiltered: list.total,
      activation_stage: stageFilter,
      items: [],
      offset: 0,
      limit: 0,
      generated_at: new Date().toISOString(),
      count_only: true,
    };
  }

  const bbSubgrupoFilter = opts.bbSubgrupo || null;
  const rematSubgrupoFilter = opts.rematSubgrupo || null;
  const cicloFilterRaw = opts.ciclo ? normalizeCiclo(String(opts.ciclo)) : '';
  const searchQuery = String(opts.search || opts.q || '').trim();

  const { matSnap, otherSnapId } = await resolveActivationSnapshotPair(category);
  const { rows, meta } = await buildRosterRowsCached(category, matSnap.id, otherSnapId);
  const rosterCached = activationRosterCaches.get(`${category}:${matSnap.id}:${otherSnapId}`);

  // Ciclos frozen devem ser excluídos do dropdown e da fila.
  const frozenSetForRoster = await frozenCyclesRepo.getFrozenSet();

  // Ciclos distintos presentes na fila (antes de qualquer filtro), excluindo frozen.
  const cicloSet = new Set();
  for (const r of rows) {
    const c = normalizeCiclo(r.ciclo || '');
    if (c && !frozenSetForRoster.has(c)) cicloSet.add(c);
  }
  const available_ciclos = [...cicloSet].sort((a, b) => b.localeCompare(a));

  // counts_by_ciclo: total por ciclo antes de qualquer filtro de stage/subgrupo/ciclo.
  // Ciclos frozen não entram.
  /** @type {Record<string, number>} */
  const counts_by_ciclo = {};
  if (available_ciclos.length > 1) {
    for (const r of rows) {
      const c = normalizeCiclo(r.ciclo || '');
      if (c && !frozenSetForRoster.has(c)) counts_by_ciclo[c] = (counts_by_ciclo[c] || 0) + 1;
    }
  }

  // bb_subgrupo_counts deve refletir o total antes do filtro de subgrupo.
  const bbSubgrupoCountsUnfiltered = meta?.bb_subgrupo_counts ?? undefined;
  const rematSubgrupoCountsUnfiltered = meta?.remat_subgrupo_counts ?? undefined;

  let filtered =
    stageFilter === 'all'
      ? rows
      : rows.filter((row) =>
          matchesActivationStageFilter(row.prior_activation_count, stageFilter)
        );

  if (bbSubgrupoFilter && category === 'acessos-blackboard') {
    filtered = filtered.filter((row) => row.bb_subgrupo === bbSubgrupoFilter);
  }

  if (rematSubgrupoFilter && category === 'rematricula') {
    filtered = filtered.filter((row) => row.remat_subgrupo === rematSubgrupoFilter);
  }

  if (cicloFilterRaw) {
    filtered = filtered.filter((row) => normalizeCiclo(row.ciclo || '') === cicloFilterRaw);
  }

  // Excluir leads de ciclos frozen (ciclo arquivado some de 100% das views operacionais).
  if (frozenSetForRoster.size > 0) {
    filtered = filtered.filter((row) => {
      const c = normalizeCiclo(row.ciclo || '');
      return !c || !frozenSetForRoster.has(c);
    });
  }

  if (searchQuery) {
    filtered = filtered.filter((row) => matchesRosterSearch(row, searchQuery));
  }

  if (responseFilter !== 'all' && filtered.length > 0) {
    const allKeys = filtered.map((it) => it.master_key).filter(Boolean);
    let stale = 72;
    try {
      const sett = await journeySettingsRepo.resolveForTerm(null);
      stale = Math.max(1, Math.floor(Number(sett?.origem_ativacao_stale_hours) || 72));
    } catch { /* default */ }
    const respondedSet = await activationResponseRepo.findRespondedMasterKeys(
      category, allKeys, stale
    );
    if (responseFilter === 'responded') {
      filtered = filtered.filter((it) => it.master_key && respondedSet.has(it.master_key));
    } else {
      filtered = filtered.filter((it) => !it.master_key || !respondedSet.has(it.master_key));
    }
  }

  // Sort por última ativação (esconde nunca-ativados se sort ativo).
  const { rows: sortedFiltered, hidden_count: sort_hidden_unactivated } = applyRosterSort(filtered, sortMode);
  filtered = sortedFiltered;

  const offset = Math.max(Number(opts.offset) || 0, 0);
  const limitRaw = Number(opts.limit);
  const pageItems =
    limitRaw > 0
      ? filtered.slice(offset, offset + Math.min(limitRaw, 500))
      : filtered.slice(offset);

  const masterKeys = pageItems.map((it) => it.master_key).filter(Boolean);
  let staleHoursForResponses = 72;
  if (masterKeys.length) {
    const rosterSettings = await journeySettingsRepo.resolveForTerm(null);
    staleHoursForResponses = Math.max(
      1,
      Math.floor(Number(rosterSettings?.origem_ativacao_stale_hours) || 72)
    );
  }
  const responsesByKey = masterKeys.length
    ? await activationResponseRepo.findLastByMasterKeys(
        category,
        masterKeys,
        staleHoursForResponses
      )
    : new Map();

  const items = pageItems.map((it) => {
    const r = it.master_key ? responsesByKey.get(it.master_key) : null;
    if (!r) return it;
    return {
      ...it,
      last_response_at: r.received_at,
      last_response_kind: r.response_kind,
      last_response_button: r.button_payload,
    };
  });

  return {
    category,
    total: filtered.length,
    total_unfiltered: rows.length,
    activation_stage: stageFilter,
    response_filter: responseFilter,
    sort: sortMode,
    sort_hidden_unactivated,
    items,
    offset,
    limit: limitRaw > 0 ? Math.min(limitRaw, 500) : items.length,
    generated_at: new Date().toISOString(),
    cached: Boolean(rosterCached && rosterCached.expires > Date.now()),
    skipped_bb_limbo: meta?.skipped_bb_limbo || 0,
    skipped_ciclo_divergente: meta?.skipped_ciclo_divergente || 0,
    bb_urgency_counts: meta?.bb_urgency_counts,
    bb_subgrupo_counts: bbSubgrupoCountsUnfiltered,
    remat_subgrupo_counts: rematSubgrupoCountsUnfiltered,
    available_ciclos,
    counts_by_ciclo,
    search: searchQuery || undefined,
    warning: meta?.remat_warning ?? undefined,
  };
}

/**
 * Retorna apenas os master_keys da fila de ativação após aplicar os mesmos filtros do
 * getActivationRoster. Payload mínimo — ideal para seleção em massa no frontend.
 */
export async function getActivationRosterKeys(category, opts = {}) {
  assertActivationCategory(category);
  const stageFilter = parseActivationStageFilter(opts.activationStage);
  const sortMode = parseRosterSort(opts.sort);
  const responseFilter = (() => {
    const v = String(opts.responseFilter || 'all').toLowerCase();
    return v === 'responded' || v === 'not_responded' ? v : 'all';
  })();

  const bbSubgrupoFilter = opts.bbSubgrupo || null;
  const rematSubgrupoFilter = opts.rematSubgrupo || null;
  const cicloFilterRaw = opts.ciclo ? normalizeCiclo(String(opts.ciclo)) : '';
  const searchQuery = String(opts.search || opts.q || '').trim();

  const { matSnap, otherSnapId } = await resolveActivationSnapshotPair(category);
  const { rows } = await buildRosterRowsCached(category, matSnap.id, otherSnapId);

  let filtered =
    stageFilter === 'all'
      ? rows
      : rows.filter((row) =>
          matchesActivationStageFilter(row.prior_activation_count, stageFilter)
        );

  if (bbSubgrupoFilter && category === 'acessos-blackboard') {
    filtered = filtered.filter((row) => row.bb_subgrupo === bbSubgrupoFilter);
  }

  if (rematSubgrupoFilter && category === 'rematricula') {
    filtered = filtered.filter((row) => row.remat_subgrupo === rematSubgrupoFilter);
  }

  if (cicloFilterRaw) {
    filtered = filtered.filter((row) => normalizeCiclo(row.ciclo || '') === cicloFilterRaw);
  }

  // Excluir leads de ciclos frozen (ciclo arquivado some de 100% das views operacionais).
  const frozenSetForKeys = await frozenCyclesRepo.getFrozenSet();
  if (frozenSetForKeys.size > 0) {
    filtered = filtered.filter((row) => {
      const c = normalizeCiclo(row.ciclo || '');
      return !c || !frozenSetForKeys.has(c);
    });
  }

  if (searchQuery) {
    filtered = filtered.filter((row) => matchesRosterSearch(row, searchQuery));
  }

  if (responseFilter !== 'all' && filtered.length > 0) {
    const allKeys = filtered.map((it) => it.master_key).filter(Boolean);
    let stale = 72;
    try {
      const sett = await journeySettingsRepo.resolveForTerm(null);
      stale = Math.max(1, Math.floor(Number(sett?.origem_ativacao_stale_hours) || 72));
    } catch { /* default */ }
    const respondedSet = await activationResponseRepo.findRespondedMasterKeys(
      category, allKeys, stale
    );
    if (responseFilter === 'responded') {
      filtered = filtered.filter((it) => it.master_key && respondedSet.has(it.master_key));
    } else {
      filtered = filtered.filter((it) => !it.master_key || !respondedSet.has(it.master_key));
    }
  }

  // Aplica mesmo sort do getActivationRoster pra bulk select bater com a tela.
  const { rows: sortedFiltered } = applyRosterSort(filtered, sortMode);
  const master_keys = sortedFiltered.map((it) => it.master_key).filter(Boolean);

  return {
    category,
    total: master_keys.length,
    master_keys,
    activation_stage: stageFilter,
    response_filter: responseFilter,
    sort: sortMode,
    generated_at: new Date().toISOString(),
  };
}

/**
 * Busca no DataCrazy, envia template conforme tier (1ª / 5ª…) e registra histórico.
 */
export async function runDatacrazyActivationBatch(category, opts = {}, callbacks = {}) {
  const onProgress = typeof callbacks.onProgress === 'function' ? callbacks.onProgress : () => {};
  const onTotal = typeof callbacks.onTotal === 'function' ? callbacks.onTotal : () => {};
  if (!process.env.DATACRAZY_API_KEY) {
    const err = new Error('DATACRAZY_API_KEY não configurada no .env');
    err.status = 503;
    throw err;
  }

  const storedTemplates = await getActivationTemplateConfig();
  const roster = await getActivationRoster(category);
  const lastSentMap = await activationDispatchRepo.getLastSentAtByMasterKey(category);
  const cooldownHours = getCooldownHoursForCategory(category);
  const cooldownNow = Date.now();
  const eligibleItems = roster.items.filter(
    (it) => !it.master_key || !isOnCooldown(lastSentMap, it.master_key, cooldownHours, cooldownNow)
  );
  const selectedKeys = Array.isArray(opts.masterKeys)
    ? new Set(opts.masterKeys.filter((k) => typeof k === 'string' && k.length > 0))
    : null;
  const filteredEligible = selectedKeys && selectedKeys.size > 0
    ? eligibleItems.filter((it) => it.master_key && selectedKeys.has(it.master_key))
    : eligibleItems;

  // Se o usuário selecionou explicitamente itens mas todos caíram fora (cooldown
  // ou já fora da fila por outro motivo), devolve erro claro em vez de
  // disparar 0 silenciosamente.
  if (selectedKeys && selectedKeys.size > 0 && filteredEligible.length === 0) {
    const onCooldown = roster.items.filter(
      (it) => it.master_key && selectedKeys.has(it.master_key)
              && isOnCooldown(lastSentMap, it.master_key, cooldownHours, cooldownNow)
    );
    const msg = onCooldown.length > 0
      ? `Os ${onCooldown.length} item(s) selecionado(s) ainda estão em cooldown de ${cooldownHours}h (último disparo recente). Aguarde ou selecione outros.`
      : 'Nenhum dos itens selecionados está elegível na fila atual.';
    const err = new Error(msg);
    err.status = 400;
    err.code = 'no_eligible_selected';
    throw err;
  }

  const maxProcess =
    Number(opts.limit) > 0
      ? Math.min(Number(opts.limit), filteredEligible.length)
      : filteredEligible.length;
  const toProcess = filteredEligible.slice(0, maxProcess);
  onTotal({ total: toProcess.length });

  // Passa vínculo email↔telefone↔cpf por pessoa pro client (formato `contacts`).
  // Permite dedupe e 1 chamada por pessoa em vez de email + telefone duplicados.
  // cpf habilita a Onda 2: lookup no cache persistente antes da API DataCrazy.
  const contacts = toProcess.map((item) => ({
    cpf: item.cpf,
    email: sanitizeContactEmail(item.email),
    phone: sanitizeContactPhone(item.telefone),
  }));

  const built = await datacrazyClient.buildLeadsLookupIndex({ contacts });
  const lookupIndex = { byEmail: built.byEmail, byPhone: built.byPhone, byCpf: built.byCpf };
  const cacheFirstLookup = built.lookup_mode === 'cache_first';

  const contactFromItem = (item) => ({
    email: sanitizeContactEmail(item.email),
    phone: sanitizeContactPhone(item.telefone),
    cpf: item.cpf,
  });

  const resolveRateRetryMax = Math.max(
    Number(process.env.DATACRAZY_RESOLVE_RATE_RETRY_MAX) || 8,
    1
  );
  const resolveRateRetryMs = Math.max(
    Number(process.env.DATACRAZY_RESOLVE_RATE_RETRY_MS) || 1500,
    500
  );

  /** @returns {Promise<{ lead: object|null, status: 'found'|'not_found'|'rate_limited' }>} */
  const resolveLeadWithRetry = async (contact) => {
    for (let attempt = 1; attempt <= resolveRateRetryMax; attempt++) {
      const cached = datacrazyClient.lookupLeadInIndex(lookupIndex, contact);
      if (cached) return { lead: cached, status: 'found' };
      if (!cacheFirstLookup) return { lead: null, status: 'not_found' };
      const resolved = await datacrazyClient.resolveLeadForContact(contact, lookupIndex);
      if (resolved.status === 'found') return resolved;
      if (resolved.status === 'not_found') return resolved;
      if (attempt < resolveRateRetryMax) {
        await sleep(resolveRateRetryMs * attempt);
      }
    }
    return { lead: null, status: 'rate_limited' };
  };

  // Pré-voo: confirma que origem_ativacao grava no CRM antes de enviar qualquer template.
  for (const item of toProcess) {
    const lead = cacheFirstLookup
      ? (await resolveLeadWithRetry(contactFromItem(item))).lead
      : datacrazyClient.lookupLeadInIndex(lookupIndex, contactFromItem(item));
    if (!lead?.id) continue;
    const preflight = await datacrazyClient.verifyOrigemAtivacaoForCategory(
      lead.id,
      category
    );
    if (preflight.skipped) {
      const err = new Error(
        `${ORIGEM_ATIVACAO_BLOCK_MESSAGE} Categoria sem mapeamento de origem_ativacao.`
      );
      err.status = 503;
      err.code = 'origem_ativacao_unavailable';
      throw err;
    }
    if (!preflight.ok) {
      const err = new Error(
        `${ORIGEM_ATIVACAO_BLOCK_MESSAGE}${preflight.error ? ` Detalhe: ${preflight.error}` : ''}`
      );
      err.status = 503;
      err.code = 'origem_ativacao_unavailable';
      throw err;
    }
    break;
  }

  // Delay redundante com whatsappSendLimiter (60/s). Default 0 = só o limiter
  // controla o ritmo. Manter > 0 só pra forçar espaçamento extra.
  const sendDelay = Math.max(Number(process.env.ACTIVATION_SEND_DELAY_MS) || 0, 0);
  // Concorrência: até N envios em paralelo. Rate limiters (WhatsApp 60/s e
  // DataCrazy CRM 20/s) protegem contra burst.
  const batchConcurrency = Math.max(
    1,
    Math.min(Number(process.env.ACTIVATION_BATCH_CONCURRENCY) || 10, 15)
  );
  const createDispatchNotes = shouldCreateDispatchNote(toProcess.length);
  const sendChannel = messagingProvider.getName();
  /** @type {Map<string, object[]>} */
  const templateComponentsByName = new Map();
  if (sendChannel === 'whatsapp' || sendChannel === 'meta' || sendChannel === 'cloud') {
    try {
      const templates = await whatsappClient.listTemplates();
      for (const tpl of templates) {
        if (tpl?.name) templateComponentsByName.set(tpl.name, tpl.components || []);
      }
    } catch (err) {
      console.warn('[ativacao] listTemplates WhatsApp:', err.message);
    }
  }
  let sent = 0;
  let not_found = 0;
  let failed = 0;
  let rate_limited = 0;
  let skipped = 0;
  /** @type {object[]} */
  const not_found_items = [];
  /** @type {object[]} */
  const results = [];
  let origem_ativacao_blocked = false;
  /** @type {string|null} */
  let origem_ativacao_error = null;

  // Processa 1 item. Retorna o outcome (não acumula contadores — quem chama
  // soma fora). Mantém todos os side-effects originais (DB writes, logs).
  /** @returns {Promise<{ status: 'sent'|'not_found'|'failed', result: object, blocked?: boolean, blockedError?: string, notFoundItem?: object }>} */
  const processItem = async (item) => {
    const master_key = item.master_key || masterKeyFromActivationItem(item);
    const prior = item.prior_activation_count ?? 0;
    const message_tier = resolveMessageTier(prior);
    const template_name =
      item.template_name ||
      resolveTemplateForActivation(category, prior, storedTemplates);

    if (!template_name) {
      await activationDispatchRepo.recordDispatchEvent({
        category,
        masterKey: master_key,
        status: 'failed',
        messageTier: message_tier,
        nome: item.nome,
        telefone: item.telefone,
        email: item.email,
        rgm: item.rgm,
        errorMessage: `Template não configurado para ${tierLabel(message_tier)}. Defina ACTIVATION_TEMPLATE_* no .env`,
      });
      return {
        status: 'failed',
        result: { ...item, status: 'failed', error: 'template_nao_configurado' },
      };
    }

    let lead = null;
    let rateLimited = false;

    if (cacheFirstLookup) {
      const resolved = await resolveLeadWithRetry(contactFromItem(item));
      lead = resolved.lead;
      rateLimited = resolved.status === 'rate_limited';
    } else {
      lead = datacrazyClient.lookupLeadInIndex(lookupIndex, contactFromItem(item));
      if (!lead) {
        const resolved = await datacrazyClient.resolveLeadForContact(
          contactFromItem(item),
          lookupIndex
        );
        if (resolved.status === 'found') lead = resolved.lead;
        else if (resolved.status === 'rate_limited') rateLimited = true;
      }
    }

    if (rateLimited) {
      await activationDispatchRepo.recordDispatchEvent({
        category,
        masterKey: master_key,
        status: 'failed',
        messageTier: message_tier,
        templateName: template_name,
        nome: item.nome,
        telefone: item.telefone,
        email: item.email,
        rgm: item.rgm,
        errorMessage: 'DataCrazy rate limit — tente novamente em alguns minutos',
      });
      return {
        status: 'failed',
        rateLimited: true,
        result: { ...item, status: 'failed', error: 'rate_limited' },
      };
    }

    if (!lead) {
      await activationDispatchRepo.recordDispatchEvent({
        category,
        masterKey: master_key,
        status: 'not_found',
        messageTier: message_tier,
        templateName: template_name,
        nome: item.nome,
        telefone: item.telefone,
        email: item.email,
        rgm: item.rgm,
      });
      return {
        status: 'not_found',
        result: { ...item, status: 'not_found', datacrazy: null },
        notFoundItem: { ...item, message_tier, template_name },
      };
    }

    let phone =
      datacrazyClient.normalizePhoneDigits(lead.rawPhone || lead.phone) ||
      datacrazyClient.normalizePhoneDigits(item.telefone);
    if (phone && phone.length <= 11) phone = `55${phone}`;
    if (!phone) {
      await activationDispatchRepo.recordDispatchEvent({
        category,
        masterKey: master_key,
        status: 'failed',
        messageTier: message_tier,
        templateName: template_name,
        datacrazyLeadId: String(lead.id ?? ''),
        nome: item.nome,
        errorMessage: 'Lead no DataCrazy sem telefone',
      });
      return {
        status: 'failed',
        result: { ...item, status: 'failed', error: 'sem_telefone' },
      };
    }

    try {
      // skipRead=true: pré-voo já validou o caminho PUT+GET; aqui só PUT.
      // Corta ~50% do tempo por pessoa (GET na API pública leva 1-2s).
      const origemResult = await datacrazyClient.verifyOrigemAtivacaoForCategory(
        lead.id,
        category,
        { skipRead: true }
      );
      try {
        const expectedOrigem = datacrazyClient.origemAtivacaoForCategory(category);
        await activationOrigemRepo.recordOrigemAtivacaoLog({
          category,
          origemValue: origemResult.value ?? expectedOrigem ?? '',
          datacrazyLeadId: String(lead.id ?? ''),
          masterKey: master_key,
          cpf: item.cpf || lead.taxId || null,
          rgm: item.rgm,
          nome: item.nome,
          status: origemResult.ok ? 'ok' : origemResult.skipped ? 'skipped' : 'failed',
          errorMessage: origemResult.error || null,
        });
      } catch (logErr) {
        console.warn('[ativacao] log origem_ativacao:', logErr.message);
      }
      if (!origemResult.ok) {
        const errMsg = origemResult.error || 'origem_ativacao';
        await activationDispatchRepo.recordDispatchEvent({
          category,
          masterKey: master_key,
          status: 'failed',
          messageTier: message_tier,
          templateName: template_name,
          datacrazyLeadId: String(lead.id ?? ''),
          nome: item.nome,
          telefone: item.telefone,
          email: item.email,
          rgm: item.rgm,
          errorMessage: `origem_ativacao: ${errMsg}`,
        });
        return {
          status: 'failed',
          blocked: true,
          blockedError: errMsg,
          result: {
            ...item,
            status: 'failed',
            error: 'origem_ativacao',
            template_name,
            message_tier,
            origem_ativacao_error: errMsg,
            datacrazy: mapDatacrazyLead(lead),
          },
        };
      }

      const variables = {
        nome: item.nome || lead.name || '',
        polo: item.polo || '',
        curso: item.curso || '',
        rgm: item.rgm || '',
      };
      await whatsappSendLimiter.acquire();
      await messagingProvider.sendTemplateMessage({
        phone,
        templateName: template_name,
        language: process.env.ACTIVATION_TEMPLATE_LANGUAGE || 'pt_BR',
        variables,
        templateComponents: templateComponentsByName.get(template_name) || [],
      });
      let datacrazyNoteFailed = false;
      let datacrazyNoteId = null;
      if (createDispatchNotes && lead?.id) {
        const renderedText = renderTemplateText(
          templateComponentsByName.get(template_name) || [],
          variables
        );
        const noteText = buildDispatchNote({
          category,
          templateName: template_name,
          renderedText,
          operatorNome: opts.operatorNome,
          timestamp: new Date(),
        });
        datacrazyClient.enqueueLeadNote(lead.id, noteText, {
          category,
          template: template_name,
        });
      }
      await activationDispatchRepo.recordDispatchEvent({
        category,
        masterKey: master_key,
        status: 'sent',
        channel: sendChannel,
        messageTier: message_tier,
        templateName: template_name,
        datacrazyLeadId: String(lead.id ?? ''),
        nome: item.nome,
        telefone: item.telefone,
        email: item.email,
        rgm: item.rgm,
        datacrazyNoteFailed,
        datacrazyNoteId,
      });
      return {
        status: 'sent',
        result: {
          ...item,
          status: 'sent',
          template_name,
          message_tier,
          origem_ativacao: origemResult.value,
          datacrazy: mapDatacrazyLead(lead),
        },
      };
    } catch (err) {
      await activationDispatchRepo.recordDispatchEvent({
        category,
        masterKey: master_key,
        status: 'failed',
        messageTier: message_tier,
        templateName: template_name,
        datacrazyLeadId: String(lead.id ?? ''),
        nome: item.nome,
        telefone: item.telefone,
        email: item.email,
        rgm: item.rgm,
        errorMessage: err.message,
      });
      return {
        status: 'failed',
        result: { ...item, status: 'failed', error: err.message, datacrazy: mapDatacrazyLead(lead) },
      };
    }
  };

  // Processa em chunks de batchConcurrency em paralelo. Mantém ordem dos
  // resultados (Promise.all preserva). Se algum item bloquear por
  // origem_ativacao, sinaliza e os chunks seguintes não rodam — itens já
  // em voo nesse chunk completam normalmente.
  for (let i = 0; i < toProcess.length; i += batchConcurrency) {
    if (origem_ativacao_blocked) break;
    const chunk = toProcess.slice(i, i + batchConcurrency);
    const outcomes = await Promise.all(chunk.map(processItem));
    for (const o of outcomes) {
      if (o.status === 'sent') sent += 1;
      else if (o.status === 'not_found') {
        not_found += 1;
        if (o.notFoundItem) not_found_items.push(o.notFoundItem);
      } else if (o.status === 'failed') {
        failed += 1;
        if (o.rateLimited) rate_limited += 1;
      }
      results.push(o.result);
      if (o.blocked) {
        origem_ativacao_blocked = true;
        origem_ativacao_error = o.blockedError || 'origem_ativacao';
      }
    }
    onProgress({
      processed: results.length,
      sent,
      failed,
      not_found,
      rate_limited,
      skipped,
      scanned: built.leadsScanned ?? null,
      pages: built.pages ?? null,
      lookup_mode: built.lookup_mode ?? null,
      cache_hits: built.cache_hits ?? null,
    });
    if (sendDelay > 0 && i + batchConcurrency < toProcess.length) {
      await sleep(sendDelay);
    }
  }

  invalidateActivationListCache(category);

  return {
    category,
    processed: toProcess.length,
    sent,
    not_found,
    failed,
    rate_limited,
    skipped,
    not_found_items,
    results,
    datacrazy_pages: built.pages,
    datacrazy_leads_scanned: built.leadsScanned,
    origem_ativacao_blocked,
    origem_ativacao_error,
    message: origem_ativacao_blocked
      ? `${ORIGEM_ATIVACAO_BLOCK_MESSAGE}${origem_ativacao_error ? ` Detalhe: ${origem_ativacao_error}` : ''}`
      : null,
  };
}

export function notFoundItemsToCsv(items) {
  const headers = [
    'nome',
    'email',
    'telefone',
    'rgm',
    'cpf',
    'polo',
    'curso',
    'message_tier',
    'template_name',
  ];
  const esc = (v) => {
    const s = String(v ?? '');
    if (s.includes('"') || s.includes(',') || s.includes('\n')) {
      return `"${s.replace(/"/g, '""')}"`;
    }
    return s;
  };
  const lines = [headers.join(',')];
  for (const row of items) {
    lines.push(
      [
        row.nome,
        row.email,
        row.telefone,
        row.rgm,
        row.cpf,
        row.polo,
        row.curso,
        row.message_tier,
        row.template_name,
      ]
        .map(esc)
        .join(',')
    );
  }
  return `\uFEFF${lines.join('\n')}`;
}

/** @param {unknown} lead */
function mapDatacrazyLead(lead) {
  if (!lead || typeof lead !== 'object') return null;
  const l = /** @type {Record<string, unknown>} */ (lead);
  const tags = Array.isArray(l.tags) ? l.tags : [];
  return {
    id: String(l.id ?? ''),
    name: String(l.name ?? ''),
    email: String(l.email ?? ''),
    phone: String(l.rawPhone ?? l.phone ?? ''),
    source: String(l.source ?? ''),
    tags: tags.map((t) => {
      if (t && typeof t === 'object' && 'name' in t) return String(t.name);
      return String(t);
    }),
  };
}

/**
 * @param {string} category
 * @param {{ offset?: number, limit?: number }} opts — limit 0 = lista inteira
 */
export async function enrichActivationWithDatacrazy(category, opts = {}) {
  if (!process.env.DATACRAZY_API_KEY) {
    const err = new Error('DATACRAZY_API_KEY não configurada no .env');
    err.status = 503;
    throw err;
  }

  const list = await getIntersectionActivationList(category, { excludeDispatched: true });
  const limitNum = opts.limit != null ? Number(opts.limit) : 0;
  const offset = Math.max(Number(opts.offset) || 0, 0);
  const items =
    limitNum === 0
      ? list.items
      : list.items.slice(offset, offset + Math.min(Math.max(limitNum, 1), 500));

  const contacts = items.map((item) => ({
    cpf: item.cpf,
    email: item.email,
    phone: item.telefone,
  }));

  const built = await datacrazyClient.buildLeadsLookupIndex({ contacts });

  const lookupIndex = { byEmail: built.byEmail, byPhone: built.byPhone, byCpf: built.byCpf };
  let found = 0;
  let notFound = 0;
  const results = items.map((item) => {
    const lead = datacrazyClient.lookupLeadInIndex(lookupIndex, {
      email: item.email,
      phone: item.telefone,
      cpf: item.cpf,
    });
    if (lead) {
      found += 1;
      return {
        ...item,
        datacrazy_found: true,
        datacrazy: mapDatacrazyLead(lead),
      };
    }
    notFound += 1;
    return {
      ...item,
      datacrazy_found: false,
      datacrazy: null,
    };
  });

  return {
    category,
    total: list.total,
    offset: 0,
    limit: items.length,
    processed: items.length,
    found,
    not_found: notFound,
    errors: 0,
    results,
    has_more: false,
    next_offset: items.length,
    mode: 'paged_index',
    datacrazy_pages: built.pages,
    datacrazy_leads_scanned: built.leadsScanned,
    datacrazy_early_stop: built.early_stop,
    datacrazy_index_reused: built.index_reused,
  };
}

export async function enrichDocsPendentesWithDatacrazy(opts = {}) {
  return enrichActivationWithDatacrazy('docs-pendentes', opts);
}

/**
 * @param {Array<Record<string, unknown>>} items
 */
export function activationListToCsv(items) {
  const headers = [
    'nome',
    'email',
    'telefone',
    'rgm',
    'cpf',
    'polo',
    'curso',
    'ciclo',
    'situacao_matricula',
    'datacrazy_id',
    'datacrazy_nome',
    'datacrazy_email',
    'datacrazy_telefone',
  ];
  const esc = (v) => {
    const s = String(v ?? '');
    if (s.includes('"') || s.includes(',') || s.includes('\n')) {
      return `"${s.replace(/"/g, '""')}"`;
    }
    return s;
  };
  const lines = [headers.join(',')];
  for (const row of items) {
    const dc = row.datacrazy || {};
    lines.push(
      [
        row.nome,
        row.email,
        row.telefone,
        row.rgm,
        row.cpf,
        row.polo,
        row.curso,
        row.ciclo,
        row.situacao_matricula,
        dc.id,
        dc.name,
        dc.email,
        dc.phone,
      ]
        .map(esc)
        .join(',')
    );
  }
  return `\uFEFF${lines.join('\n')}`;
}
