/**
 * engine/services/exoLiveState.js
 *
 * Tracks, in memory, the commander's in-progress Genetic Sampler session —
 * which genus/species they're currently collecting, where each sample so
 * far was taken, and (once we know the position) how far they currently
 * are from the nearest previous sample vs. the genus's required colony
 * range. This is what powers the live "how far until my next sample
 * counts" HUD, the equivalent of SRVSurvey's sample-distance overlay but
 * built from our own journal pipeline and geo helpers rather than any
 * external tool's code.
 *
 * Deliberately separate from exobiologyProvider.js: that module is the
 * durable lifetime catalog (built by a worker walking the journal files),
 * this one is transient session state driven by live ScanOrganic events
 * and Status.json position ticks, reset on app restart or when a session
 * completes/aborts.
 */

const eventBus = require('../core/eventBus');
const { bearingDistance } = require('../core/geo');
const { getColonyRangeM } = require('../data/exoColonyRanges');

let _session = null;        // { genus, genusName, species, speciesName, requiredM, samples: [{lat,lon}] }
let _lastPosition = null;   // { latitude, longitude, planetRadiusM } — updated on every Status.json tick

// ── Position feed ─────────────────────────────────────────────────────────
// journalProvider's Status.json watcher calls this on every tick regardless
// of whether a session is active, so we always have a current fix by the
// time a ScanOrganic event needs one.
function updatePosition(latitude, longitude, planetRadiusM) {
  if (latitude == null || longitude == null) return;
  _lastPosition = { latitude, longitude, planetRadiusM: planetRadiusM ?? null };
}

function clearPosition() {
  _lastPosition = null;
}

// ── Sample events ────────────────────────────────────────────────────────
// ScanType progression per organism: 'Log' (1st sample, starts the
// canister), 'Sample' (2nd), 'Analyse' (3rd — completes and empties the
// canister). A Log for a *different* genus/species than the current
// session means the commander switched targets (or started fresh after
// selling), so we just replace the session rather than trying to merge.
function recordScan(entry) {
  if (!entry) return;
  const genus   = entry.Genus || null;
  const species = entry.Species || null;
  const scanType = entry.ScanType || null;
  if (!genus) return;

  const isSameTarget = _session && _session.genus === genus && _session.species === species;

  if (entry.ScanType === 'Log' && !isSameTarget) {
    _session = {
      genus,
      genusName:   entry.Genus_Localised || null,
      species,
      speciesName: entry.Species_Localised || null,
      requiredM:   getColonyRangeM(genus),
      samples:     [],
    };
  } else if (!_session) {
    // Defensive: a Sample/Analyse arrived with no active Log (e.g. app was
    // launched mid-session) — start tracking from here anyway.
    _session = {
      genus,
      genusName:   entry.Genus_Localised || null,
      species,
      speciesName: entry.Species_Localised || null,
      requiredM:   getColonyRangeM(genus),
      samples:     [],
    };
  }

  if (_lastPosition) {
    _session.samples.push({ latitude: _lastPosition.latitude, longitude: _lastPosition.longitude });
  }

  if (scanType === 'Analyse') {
    // Canister just completed and emptied — session is over. Emit one last
    // "complete" progress so the HUD can flash success before clearing.
    eventBus.emit('exo.sampleComplete', { ..._session });
    _session = null;
  }

  eventBus.emit('exo.sessionChanged', getProgress());
}

function clearSession() {
  if (!_session) return;
  _session = null;
  eventBus.emit('exo.sessionChanged', null);
}

// ── Progress ─────────────────────────────────────────────────────────────
// Distance-to-nearest-sample, not distance-to-most-recent-sample — the
// game only requires you be far enough from *any* previous sample of this
// organism, not specifically the last one, so nearest is the honest
// "am I clear yet" answer.
function getProgress() {
  if (!_session) return null;
  if (!_lastPosition || !_session.samples.length) {
    return {
      genus: _session.genus, genusName: _session.genusName,
      species: _session.species, speciesName: _session.speciesName,
      requiredM: _session.requiredM,
      samplesTaken: _session.samples.length,
      distanceM: null, met: null,
    };
  }

  const planetRadiusM = _lastPosition.planetRadiusM;
  let nearestM = Infinity;
  for (const s of _session.samples) {
    const d = bearingDistance(s.latitude, s.longitude, _lastPosition.latitude, _lastPosition.longitude, planetRadiusM);
    if (d && d.distanceM < nearestM) nearestM = d.distanceM;
  }
  if (!Number.isFinite(nearestM)) nearestM = null;

  return {
    genus: _session.genus, genusName: _session.genusName,
    species: _session.species, speciesName: _session.speciesName,
    requiredM: _session.requiredM,
    samplesTaken: _session.samples.length,
    distanceM: nearestM,
    met: (nearestM != null && _session.requiredM != null) ? nearestM >= _session.requiredM : null,
  };
}

function getSession() {
  return _session;
}

module.exports = {
  updatePosition, clearPosition,
  recordScan, clearSession,
  getProgress, getSession,
};
