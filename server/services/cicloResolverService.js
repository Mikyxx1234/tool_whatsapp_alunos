import * as baseUploadRepo from '../repositories/baseUploadRepository.js';
import { cicloFromRow } from '../utils/cicloFromRow.js';
import { normalizeRgmCanonical } from '../utils/rgmDisplay.js';

const RGM_KEYS = [
  'RGM', 'Rgm', 'rgm',
  'Matricula', 'matricula', 'MATRICULA',
  'Matrícula', 'MATRÍCULA', 'matrícula',
  'Username', 'username', 'Login', 'login',
];

const CACHE_TTL_MS = 5 * 60 * 1000;

/** @type {{ expires: number, map: Map<string, string>, ciclos: string[] } | null} */
let cicloCache = null;

export function bustCicloCache() {
  cicloCache = null;
}

async function buildCache() {
  const matSnap = await baseUploadRepo.getLatestSnapshot('matriculados');
  if (!matSnap) return { map: new Map(), ciclos: [] };

  /** @type {Map<string, string>} */
  const map = new Map();
  await baseUploadRepo.forEachRowDataForSnapshot('matriculados', matSnap.id, (row) => {
    const ciclo = cicloFromRow(row);
    if (!ciclo) return;
    for (const k of RGM_KEYS) {
      const rgm = normalizeRgmCanonical(row[k]);
      if (rgm) {
        map.set(rgm, ciclo);
        break;
      }
    }
  });

  const cicloSet = new Set(map.values());
  const ciclos = [...cicloSet].filter(Boolean).sort((a, b) => b.localeCompare(a));
  return { map, ciclos };
}

/**
 * Returns Map{canonical_rgm → ciclo} built from the latest matriculados snapshot.
 * @returns {Promise<Map<string, string>>}
 */
export async function getRgmToCicloMap() {
  if (cicloCache && cicloCache.expires > Date.now()) return cicloCache.map;
  const { map, ciclos } = await buildCache();
  cicloCache = { expires: Date.now() + CACHE_TTL_MS, map, ciclos };
  return map;
}

/**
 * Returns ciclos sorted descending (e.g. ['2026/2', '2026/1']).
 * @returns {Promise<string[]>}
 */
export async function getAvailableCiclos() {
  if (cicloCache && cicloCache.expires > Date.now()) return cicloCache.ciclos;
  const { map, ciclos } = await buildCache();
  cicloCache = { expires: Date.now() + CACHE_TTL_MS, map, ciclos };
  return ciclos;
}

/**
 * Extracts the RGM from a master_key string (e.g. 'RGM:12345678' → '12345678').
 * Returns null for non-RGM keys.
 * @param {string | null | undefined} masterKey
 * @returns {string | null}
 */
export function rgmFromMasterKey(masterKey) {
  if (!masterKey || !masterKey.startsWith('RGM:')) return null;
  return masterKey.slice(4) || null;
}

/**
 * Builds an array of master_key strings ('RGM:<rgm>') for all RGMs
 * belonging to the given ciclo.
 * @param {Map<string, string>} cicloMap
 * @param {string} ciclo
 * @returns {string[]}
 */
export function masterKeysForCiclo(cicloMap, ciclo) {
  const out = [];
  for (const [rgm, c] of cicloMap) {
    if (c === ciclo) out.push('RGM:' + rgm);
  }
  return out;
}
