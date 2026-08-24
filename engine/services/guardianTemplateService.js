/**
 * engine/services/guardianTemplateService.js
 *
 * Deterministic, always-available Guardian site geometry: given a
 * (siteType, variant) our own template dataset (data/guardianSiteTemplates.json
 * — converted from SrvSurvey's surveyed geometry, see
 * scripts/convert-guardian-templates.js and ATTRIBUTION.md) already knows
 * the full POI layout without needing a live API call at all. This is now
 * the PRIMARY source for guardianSitesService.js; Canonn (canonnClient.js)
 * becomes a secondary enrichment used only to confirm discovery / fill gaps
 * our own dataset doesn't have (e.g. a newly-catalogued site type).
 *
 * Local -> world bearing convention (deliberately our own, not SrvSurvey's):
 * a template's `bearingDeg` is stored relative to the site's own "as
 * surveyed" orientation. To place a POI in the real world we rotate that
 * local bearing by the site instance's recorded `siteHeadingDeg`:
 *
 *   worldBearingDeg = normalize360(templateBearingDeg + siteHeadingDeg)
 *
 * Cross-checked (not just assumed) against SrvSurvey's own Util.cs: their
 * live commander-tracking code computes the inverse relationship —
 * `localAngle = getBearing(playerPos, siteLocation) - siteHeading` — which
 * is algebraically the same world<->local relationship used here. (Their
 * separate raster-plotter draw path has an extra `180 -` term, but that's
 * a canvas-rotation artifact of their renderer, not part of the underlying
 * geometry, and doesn't apply to our vector renderer.) Elite Explorer's own
 * `ui/guardian-script.js:bearingDistanceToXY()` expects true world compass
 * bearings (0 = north) as input, which is what this convention produces.
 *
 * If a site's real-world heading isn't known yet (fresh sighting, not yet
 * matched against the known-site bootstrap dataset), pois/groups are still
 * returned using the raw template bearing (siteHeadingDeg treated as 0) —
 * good enough for "what POIs exist and roughly how far apart" until a real
 * heading is available.
 */

const fs = require('fs');
const path = require('path');

const TEMPLATES_PATH = path.join(__dirname, '..', '..', 'data', 'guardianSiteTemplates.json');
const KNOWN_SITES_PATH = path.join(__dirname, '..', '..', 'data', 'guardianKnownSites.json');

let _templates = null;
let _knownSites = null;
let _loggedTemplatesError = false;
let _loggedKnownSitesError = false;

function loadTemplates() {
  if (_templates) return _templates;
  try {
    const raw = JSON.parse(fs.readFileSync(TEMPLATES_PATH, 'utf8'));
    _templates = raw.templates || {};
  } catch (err) {
    // Don't let a missing/corrupt data file take down every caller up the
    // chain (guardianSitesService.getAllSites() maps over every row through
    // this — one throw here used to silently empty the entire site picker).
    // Cache an empty result so we only try (and fail) once per app run,
    // not once per row.
    if (!_loggedTemplatesError) {
      console.error('[guardianTemplateService] Failed to load guardianSiteTemplates.json:', err.message, '(path:', TEMPLATES_PATH, ')');
      _loggedTemplatesError = true;
    }
    _templates = {};
  }
  return _templates;
}

function loadKnownSites() {
  if (_knownSites) return _knownSites;
  try {
    const raw = JSON.parse(fs.readFileSync(KNOWN_SITES_PATH, 'utf8'));
    _knownSites = raw.sites || [];
  } catch (err) {
    if (!_loggedKnownSitesError) {
      console.error('[guardianTemplateService] Failed to load guardianKnownSites.json:', err.message, '(path:', KNOWN_SITES_PATH, ')');
      _loggedKnownSitesError = true;
    }
    _knownSites = [];
  }
  return _knownSites;
}

function normalize360(deg) {
  let d = deg % 360;
  if (d < 0) d += 360;
  return d;
}

/** Returns the raw template record for a (siteType, variant), or null. */
function getTemplate(siteType, variant) {
  if (!siteType || !variant) return null;
  const templates = loadTemplates();
  return templates[`${siteType}:${variant}`] || null;
}

/**
 * Builds pois[] + obeliskGroups[] + scale for a real site instance, rotated
 * into world bearings by siteHeadingDeg (see convention above). Returns
 * null if we have no template for this (siteType, variant) combo.
 */
function buildSitePois({ siteType, variant, siteHeadingDeg }) {
  const template = getTemplate(siteType, variant);
  if (!template) return null;

  const heading = Number.isFinite(siteHeadingDeg) ? siteHeadingDeg : 0;

  const pois = template.pois.map((p) => ({
    id: p.id,
    type: p.type,
    bearingDeg: Number(normalize360(p.bearingDeg + heading).toFixed(2)),
    distanceM: p.distanceM,
    label: p.label,
    notes: p.notes,
  }));

  const obeliskGroups = (template.obeliskGroups || []).map((g) => ({
    id: g.id,
    label: g.label,
    bearingDeg: Number(normalize360(g.bearingDeg + heading).toFixed(2)),
    distanceM: g.distanceM,
    obeliskCount: g.obeliskCount,
  }));

  return { pois, obeliskGroups, scale: template.scale };
}

/** Every (siteType, variant) we have a template for, for the site picker / editor. */
function listTemplateKeys() {
  return Object.keys(loadTemplates());
}

/**
 * Finds a bootstrap known-site record by system + body, for seeding a
 * commander's first visit with real siteHeading/origin data instead of
 * waiting on a live journal sighting to supply it.
 */
function findKnownSite({ systemAddress, systemName, bodyName }) {
  const sites = loadKnownSites();
  if (systemAddress) {
    const bySys = sites.filter((s) => String(s.systemAddress) === String(systemAddress));
    if (bySys.length) {
      if (bodyName) {
        const exact = bySys.find((s) => (s.bodyName || '').trim().toUpperCase() === bodyName.trim().toUpperCase());
        if (exact) return exact;
      }
      return bySys[0];
    }
  }
  if (systemName) {
    const bySys = sites.filter((s) => (s.systemName || '').trim().toUpperCase() === systemName.trim().toUpperCase());
    if (bySys.length) return bySys[0];
  }
  return null;
}

module.exports = {
  getTemplate,
  buildSitePois,
  listTemplateKeys,
  findKnownSite,
  loadKnownSites,
};
