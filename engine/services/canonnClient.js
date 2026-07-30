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
 * FIELD SHAPE — confirmed, not guessed. Canonn's own developers publicly
 * quoted real /gssites and /grsites REST responses while filing Strapi bugs
 * upstream (github.com/strapi/strapi issues #2308, #2396, #2405), and
 * docs.canonn.tech's Report Types page documents the parallel POST shape
 * for the same site types. Combining those:
 *
 *   GET /gssites?system.systemName=<name>   (Guardian Structures)
 *   GET /grsites?system.systemName=<name>   (Guardian Ruins)
 *
 *   [{
 *     id: 1, siteID: 1,
 *     system: { systemName: "SYNUEFE LY-I B42-2" },
 *     body:   { bodyName: "C 2" },
 *     latitude: 52.6791, longitude: 115.2503,
 *     type: { type: "Lacrosse", journalName: "ancient_tiny_001" },  // GS only
 *     verified: true,
 *     discoveredBy: { cmdrName: "..." },
 *     activeGroups: [...], activeObelisks: [...]  // GS only, shape TBD (see below)
 *   }, ...]
 *
 * The site-level fields above (system/body names, siteID, lat/long, type)
 * are solid — they come straight from Canonn devs describing their own
 * production data. `activeGroups`/`activeObelisks` are confirmed to EXIST
 * on GS records (referenced by name in strapi issue #2396) but their
 * internal shape was never shown in anything we could find, so
 * mapCanonnResponseToSite() in guardianSitesService.js reads them
 * defensively — best-effort extraction, never a hard failure if the shape
 * doesn't match what we guessed.
 *
 * The API has gone through Strapi version bumps since those 2018 threads
 * (Canonn's own repo history shows a v4 rebuild in 2023), so top-level
 * field names could plausibly have drifted. CANDIDATE_PATHS below tries a
 * couple of query-param spellings per site type before giving up, so a
 * small drift (e.g. a flattened `systemName` instead of `system.systemName`)
 * degrades gracefully instead of just returning nothing.
 */

const BASE_URL = 'https://api.canonn.tech';
const TIMEOUT_MS = 10000;

// One candidate list per our siteType, tried in order. Each entry is a
// { restType, buildPath } pair — restType tags which Canonn collection
// answered, since /gssites and /grsites have different field shapes
// (only GS carries `type`/`activeGroups`/`activeObelisks`).
const CANDIDATES = {
  structure: [
    { restType: 'gssites', buildPath: (s) => `/gssites?system.systemName=${encodeURIComponent(s)}` },
    { restType: 'gssites', buildPath: (s) => `/gssites?systemName=${encodeURIComponent(s)}` },
  ],
  ruins: [
    { restType: 'grsites', buildPath: (s) => `/grsites?system.systemName=${encodeURIComponent(s)}` },
    { restType: 'grsites', buildPath: (s) => `/grsites?systemName=${encodeURIComponent(s)}` },
  ],
};

async function fetchJson(path) {
  const res = await fetch(BASE_URL + path, { signal: AbortSignal.timeout(TIMEOUT_MS) });
  if (!res.ok) throw new Error('HTTP ' + res.status + ' for ' + path);
  return await res.json();
}

/**
 * Fetches Guardian site records for a system, for a given our-schema
 * siteType ('structure' | 'ruins'). Returns { restType, raw: [...] } where
 * raw is Canonn's array of site records for that system, or null if
 * nothing usable came back from any candidate path (no sites in that
 * system, or the API is unreachable).
 */
async function fetchGuardianSitesForSystem(systemName, siteType) {
  if (!systemName || !siteType) return null;
  const candidates = CANDIDATES[siteType];
  if (!candidates) return null;

  for (const { restType, buildPath } of candidates) {
    const path = buildPath(systemName);
    try {
      const json = await fetchJson(path);
      const arr = Array.isArray(json) ? json : (json && Array.isArray(json.data) ? json.data : null);
      if (arr && arr.length) return { restType, path, raw: arr };
    } catch {
      // try the next candidate quietly — a 404/shape-mismatch just means
      // that spelling isn't right on this API version, not that the site
      // doesn't exist.
    }
  }
  return null;
}

/**
 * Dev-time helper: fetch a known Guardian system and log the raw shape so
 * we can sanity-check field drift against actual live data. Not used in
 * the running app — call manually from a scratch script if the mapping in
 * guardianSitesService.js ever needs re-verifying against a live response.
 */
async function probeSystem(systemName, siteType) {
  const result = await fetchGuardianSitesForSystem(systemName, siteType || 'structure');
  if (!result) {
    console.log(`[canonnClient] No response for "${systemName}" (${siteType}) from any candidate path.`);
    return null;
  }
  console.log(`[canonnClient] "${systemName}" responded via ${result.path}`);
  console.log(JSON.stringify(result.raw, null, 2));
  return result;
}

module.exports = { fetchGuardianSitesForSystem, probeSystem };
