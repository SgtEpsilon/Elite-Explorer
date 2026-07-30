/**
 * engine/services/canonnClient.js
 *
 * Thin client for Canonn Research's public API (docs.canonn.tech). This is
 * an ORIGINAL implementation written against Canonn's public HTTP interface
 * — Canonn's software is GPL-3.0, but that license covers their server code,
 * not the response data you get back from calling a public API over HTTP.
 * No code, JSON structures, or assets from SrvSurvey or any other GPL
 * project were consulted or copied to write this file.
 *
 * WHY THIS FILE LOOKS DEFENSIVE: Canonn's own documentation
 * (docs.canonn.tech) is explicitly marked work-in-progress, and their API
 * has changed shape multiple times over the project's history (Strapi
 * version bumps, REST → REST+GraphQL). Rather than hardcode a guessed field
 * schema and risk silently mis-mapping POI data, this client:
 *
 *   1. Tries a short list of plausible endpoint paths for a given system
 *      (see CANDIDATE_PATHS below) and returns the first one that responds
 *      with JSON we can work with.
 *   2. Exposes `probeSystem()` — a dev-time helper that dumps the raw JSON
 *      shape for a known Guardian system so we can look at it together and
 *      lock in the *real* field names in guardianSitesService.js's mapping
 *      function, instead of guessing.
 *
 * Once we've confirmed the real shape against a live system (e.g. Synuefe
 * XR-H d11-102, HIP 22460, or another well-known Guardian system), we should
 * collapse CANDIDATE_PATHS down to the one real path and delete the probing
 * logic — this is meant to be a temporary, honest scaffold, not the
 * permanent shape of this file.
 */

const BASE_URL = 'https://api.canonn.tech';
const TIMEOUT_MS = 10000;

// Plausible GET paths for per-system Guardian site + POI data, based on
// publicly-documented example queries (e.g. `/apsites?system.systemName=`)
// and the GEN/GB/GS/GR/TB/TS report-type codes Canonn's own team has used
// in public GitHub discussion (GR = Guardian Ruins, GS = Guardian Structure).
// This list is a starting point for probing, not a confirmed contract.
const CANDIDATE_PATHS = [
  (system) => `/apsites?system.systemName=${encodeURIComponent(system)}`,
  (system) => `/gr-sites?system.systemName=${encodeURIComponent(system)}`,
  (system) => `/gs-sites?system.systemName=${encodeURIComponent(system)}`,
  (system) => `/sites?system.systemName=${encodeURIComponent(system)}&type=guardian`,
];

async function fetchJson(path) {
  const res = await fetch(BASE_URL + path, { signal: AbortSignal.timeout(TIMEOUT_MS) });
  if (!res.ok) throw new Error('HTTP ' + res.status + ' for ' + path);
  return await res.json();
}

/**
 * Attempts each candidate path in turn for the given system name, returning
 * the first non-empty JSON response along with which path produced it.
 * Returns null if nothing responded usefully (e.g. no Guardian sites in
 * this system, or the API is unreachable).
 */
async function fetchGuardianSitesForSystem(systemName) {
  if (!systemName) return null;

  for (const buildPath of CANDIDATE_PATHS) {
    const path = buildPath(systemName);
    try {
      const json = await fetchJson(path);
      if (json && (Array.isArray(json) ? json.length : Object.keys(json).length)) {
        return { path, raw: json };
      }
    } catch {
      // try the next candidate quietly — a 404 just means that path isn't it
    }
  }
  return null;
}

/**
 * Dev-time helper: fetch a known Guardian system and log the raw shape so
 * we can design the real field mapping against actual data. Not used in
 * the running app — call this manually from a scratch script when we're
 * ready to lock in the mapping.
 */
async function probeSystem(systemName) {
  const result = await fetchGuardianSitesForSystem(systemName);
  if (!result) {
    console.log(`[canonnClient] No response for "${systemName}" from any candidate path.`);
    return null;
  }
  console.log(`[canonnClient] "${systemName}" responded via ${result.path}`);
  console.log(JSON.stringify(result.raw, null, 2));
  return result;
}

module.exports = { fetchGuardianSitesForSystem, probeSystem };
