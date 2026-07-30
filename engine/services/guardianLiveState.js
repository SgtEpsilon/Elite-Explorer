/**
 * engine/services/guardianLiveState.js
 *
 * Tracks, in memory, whether the commander is currently "at" a cached
 * Guardian site — and if so, which one — so the Status.json watcher in
 * journalProvider.js knows when to bother computing/pushing a live
 * position, and so a freshly-loaded guardian.html can ask "is there an
 * active site right now?" without re-deriving it.
 *
 * Deliberately separate from guardianSitesService.js: that module is the
 * durable cache (SQLite), this one is transient session state that resets
 * every app restart. Communicates outward via the existing eventBus rather
 * than importing electron directly, so it stays testable/headless like the
 * rest of engine/.
 */

const eventBus = require('../core/eventBus');

let _activeSite = null;        // full site record (see guardianSitesService.rowsToSiteRecord), or null
let _planetRadiusM = null;     // latest PlanetRadius seen in Status.json, meters

function setActive(site) {
  _activeSite = site || null;
  eventBus.emit('guardian.siteActive', _activeSite);
}

function clear() {
  if (!_activeSite) return;
  _activeSite = null;
  eventBus.emit('guardian.siteActive', null);
}

function getActive() {
  return _activeSite;
}

function setPlanetRadius(radiusM) {
  if (radiusM != null && !Number.isNaN(radiusM)) _planetRadiusM = radiusM;
}

function getPlanetRadius() {
  return _planetRadiusM;
}

module.exports = { setActive, clear, getActive, setPlanetRadius, getPlanetRadius };
