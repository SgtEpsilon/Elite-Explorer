/**
 * journalWorker.js
 * Runs in a Worker Thread.
 *
 * Accepts a `mode` in workerData:
 *   'live'    — ship, fuel, location, docking from the current session only
 *   'profile' — most-recent LoadGame, Rank, Progress, Reputation, Statistics
 *   'history' — every FSDJump across all supplied files
 *   'all'     — everything above (used by legacy callers)
 */

const { workerData, parentPort } = require('worker_threads');
const fs   = require('fs');
const path = require('path');

const { files, lastProcessed, mode = 'all' } = workerData;
const PROGRESS_INTERVAL = 500;

const doLive    = mode === 'live'    || mode === 'all';
const doProfile = mode === 'profile' || mode === 'all';

// ── Rank lookup tables ────────────────────────────────────────────────────────
const COMBAT_RANKS     = ['Harmless','Mostly Harmless','Novice','Competent','Expert','Master','Dangerous','Deadly','Elite'];
const TRADE_RANKS      = ['Penniless','Mostly Penniless','Peddler','Dealer','Merchant','Broker','Entrepreneur','Tycoon','Elite'];
const EXPLORE_RANKS    = ['Aimless','Mostly Aimless','Scout','Surveyor','Trailblazer','Pathfinder','Ranger','Pioneer','Elite'];
const CQC_RANKS        = ['Helpless','Mostly Helpless','Amateur','Semi Professional','Professional','Champion','Hero','Gladiator','Elite'];
const EMPIRE_RANKS     = ['None','Outsider','Serf','Master','Squire','Knight','Lord','Baron','Viscount','Count','Earl','Marquis','Duke','Prince','King'];
const FEDERATION_RANKS = ['None','Recruit','Cadet','Midshipman','Petty Officer','Chief Petty Officer','Warrant Officer','Ensign','Lieutenant','Lieutenant Commander','Post Commander','Post Captain','Rear Admiral','Vice Admiral','Admiral'];
const EXOBIO_RANKS     = ['Directionless','Mostly Directionless','Compiler','Collector','Cataloguer','Taxonomist','Ecologist','Geneticist','Elite'];

// Resolve a rank level to its display name.
// Odyssey introduced Elite I / II / III — rank values beyond the last array
// index (e.g. Trade:9 when the array only goes to index 8 for "Elite").
// The old `RANKS[level] || RANKS[0]` pattern silently returned the *lowest*
// rank name for any out-of-bounds value, which is wrong.
const ELITE_TIERS = ['Elite I', 'Elite II', 'Elite III'];
function getRankName(ranks, level) {
  if (level == null || level < 0) return ranks[0];
  if (level < ranks.length)       return ranks[level];
  // Beyond the top of the array — map to Elite I / II / III
  const tierIndex = level - ranks.length; // 0 → Elite I, 1 → Elite II, 2 → Elite III
  return ELITE_TIERS[tierIndex] || ('Elite ' + (tierIndex + 1));
}

async function run() {
  const totalFiles            = files.length;
  const updatedLastProcessed  = { ...lastProcessed };

  // Live data accumulator (ship, fuel, location, docking)
  let liveData = null;

  // Live bodies accumulator — cleared on each FSDJump, built up as Scan events arrive.
  // Keyed by body name so duplicate scans just overwrite.
  let liveBodies     = {};   // bodyName → scan entry
  let liveBodySystem = null; // system name these bodies belong to
  let liveSignals    = {};   // bodyName → array of signal strings (bio, geo, stations etc)

  // Profile data accumulator (identity, ranks, rep, stats)
  let profileIdentity   = null;
  let profileRanks      = null;
  let profileProgress   = null;
  let profileReputation = null;
  let profileStats      = null;

  for (let fileIndex = 0; fileIndex < files.length; fileIndex++) {
    const filePath = files[fileIndex];
    const fileName = path.basename(filePath);

    let content;
    try {
      content = await fs.promises.readFile(filePath, 'utf8');
    } catch (err) {
      parentPort.postMessage({ type: 'error', file: fileName, message: err.message });
      continue;
    }

    const lines      = content.split('\n');
    const startIndex = (lastProcessed[fileName] != null) ? lastProcessed[fileName] + 1 : 0;
    const totalLines = lines.length;

    for (let i = startIndex; i < totalLines; i++) {
      const line = lines[i].trim();
      if (!line) continue;

      try {
        const entry = JSON.parse(line);
        const ev    = entry.event;

        // ── Scan event (emitted immediately, used for DB) ─────────────
        if (ev === 'Scan') {
          parentPort.postMessage({
            type: 'event', event: 'journal.scan',
            data: { system: entry.StarSystem, body: entry.BodyName, bodyType: entry.BodyType, timestamp: entry.timestamp }
          });
          // Forward raw entry for EDDN relay (live mode only — never replay old scans)
          if (doLive) {
            parentPort.postMessage({ type: 'raw', event: ev, entry });
          }
        }

        // ── Location / system changes ─────────────────────────────────
        if (ev === 'Location' || ev === 'FSDJump') {
          parentPort.postMessage({
            type: 'event', event: 'journal.location',
            data: { system: entry.StarSystem, timestamp: entry.timestamp, coords: entry.StarPos || null }
          });
        }

        // ── Raw event forwarding for EDDN relay (live watcher only) ──
        // Location and CarrierJump are needed so eddnRelay can track
        // StarPos from the moment the session starts (not just on jumps).
        if (doLive && (ev === 'FSDJump' || ev === 'Docked' || ev === 'Location' || ev === 'CarrierJump')) {
          parentPort.postMessage({ type: 'raw', event: ev, entry });
        }

        // ── LIVE DATA ─────────────────────────────────────────────────
        if (doLive) {
          if (ev === 'Location') {
            if (!liveData) liveData = {};
            liveData.currentSystem = entry.StarSystem;
            liveData.pos = entry.StarPos ? entry.StarPos.map(n => n.toFixed(2)).join(', ') : null;
            // Track current system for bodies so scans logged before this point
            // (e.g. from a previous session in the same file) are attributed correctly.
            // Only update liveBodySystem — do NOT clear liveBodies here; scans
            // already accumulated in this file's pass belong to this system.
            if (!liveBodySystem) {
              liveBodySystem = entry.StarSystem;
              // Emit whatever bodies have been collected so far in this file
              // so the panel populates on app boot when the game is already running.
              parentPort.postMessage({
                type: 'bodies-data',
                system:  liveBodySystem,
                bodies:  Object.values(liveBodies),
                signals: liveSignals,
              });
            }
          }

          if (ev === 'FSDJump') {
            if (!liveData) liveData = {};
            liveData.currentSystem = entry.StarSystem;
            liveData.pos           = entry.StarPos ? entry.StarPos.map(n => n.toFixed(2)).join(', ') : null;
            liveData.jumpRange     = entry.JumpDist ? entry.JumpDist.toFixed(2) + ' ly' : null;
            liveData.lastJumpWasFirstDiscovery = (entry.SystemAlreadyDiscovered === false);
            // Clear bodies when entering a new system
            liveBodies     = {};
            liveSignals    = {};
            liveBodySystem = entry.StarSystem;
            parentPort.postMessage({ type: 'bodies-data', system: liveBodySystem, bodies: [], signals: {} });
          }

          // ── Scan event → add/update body in the live bodies map ───────────
          if (ev === 'Scan') {
            liveBodySystem = entry.StarSystem || liveBodySystem;
            const name = entry.BodyName || '';
            liveBodies[name] = {
              name,
              bodyId:       entry.BodyID,
              parentId:     Array.isArray(entry.Parents) ? (entry.Parents[0] ? Object.values(entry.Parents[0])[0] : null) : null,
              type:         entry.StarType        ? 'Star'   :
                            entry.PlanetClass     ? 'Planet' : 'Belt',
              starType:     entry.StarType        || null,
              subclass:     entry.Subclass        != null ? entry.Subclass : null,
              luminosity:   entry.Luminosity      || null,
              planetClass:  entry.PlanetClass     || null,
              terraformable:entry.TerraformState === 'Terraformable',
              atmosphere:   entry.Atmosphere      || null,
              atmosphereType: entry.AtmosphereType|| null,
              volcanism:    entry.Volcanism        || null,
              landable:     entry.Landable         === true,
              distanceFromArrival: entry.DistanceFromArrivalLS || null,
              radius:       entry.Radius           != null ? Math.round(entry.Radius / 1000) : null, // km
              gravity:      entry.SurfaceGravity   != null ? (entry.SurfaceGravity / 9.8).toFixed(2) : null,
              surfaceTemp:  entry.SurfaceTemperature != null ? Math.round(entry.SurfaceTemperature) : null,
              massEM:       entry.MassEM           != null ? entry.MassEM.toFixed(3) : null,
              solarMasses:  entry.StellarMass      != null ? entry.StellarMass.toFixed(3) : null,
              solarRadius:  entry.Radius && entry.StarType ? (entry.Radius / 696340000).toFixed(3) : null,
              absoluteMag:  entry.AbsoluteMagnitude != null ? entry.AbsoluteMagnitude.toFixed(2) : null,
              orbitalPeriod: entry.OrbitalPeriod   != null ? (entry.OrbitalPeriod / 86400).toFixed(2) : null, // days
              rotationPeriod: entry.RotationPeriod != null ? (entry.RotationPeriod / 86400).toFixed(2) : null,
              axialTilt:    entry.AxialTilt        != null ? (entry.AxialTilt * 180 / Math.PI).toFixed(1) : null,
              rings:        Array.isArray(entry.Rings) && entry.Rings.length > 0,
              ringTypes:    Array.isArray(entry.Rings) ? entry.Rings.map(r => r.RingClass?.replace('eRingClass_', '') || '?') : [],
              materials:    entry.Materials        || null,
              composition:  entry.Composition      || null,
              wasDiscovered: entry.WasDiscovered   !== false,
              wasMapped:    entry.WasMapped        !== false,
              mappedValue:  entry.MappedValue      || null,
              estimatedValue: entry.EstimatedValue || null,
              isScoopable:  entry.StarType ? 'KGBFOAM'.includes(entry.StarType[0]) : false,
              timestamp:    entry.timestamp,
            };
            parentPort.postMessage({
              type: 'bodies-data',
              system:  liveBodySystem,
              bodies:  Object.values(liveBodies),
              signals: liveSignals,
            });
          }

          // ── FSSDiscoveryScan (Discovery Scanner fired) ───────────────────────
          // Flush current bodies immediately and signal edsmClient to re-fetch,
          // so the System Bodies panel gets the freshest data right away.
          if (ev === 'FSSDiscoveryScan') {
            liveBodySystem = entry.SystemName || liveBodySystem;
            parentPort.postMessage({
              type:    'bodies-data',
              system:  liveBodySystem,
              bodies:  Object.values(liveBodies),
              signals: liveSignals,
            });
            parentPort.postMessage({
              type:  'event',
              event: 'journal.fss-scan',
              data:  { system: entry.SystemName || liveBodySystem, timestamp: entry.timestamp },
            });
          }

          // ── SAASignalsFound → biological / geological signals per body ─────
          if (ev === 'SAASignalsFound') {
            const bodyName = entry.BodyName || '';
            const sigs = (entry.Signals || []).map(s => {
              const t = s.Type_Localised || s.Type || '';
              const c = s.Count != null ? ' \u00D7' + s.Count : '';
              return t + c;
            });
            if (sigs.length) {
              liveSignals[bodyName] = sigs;
              parentPort.postMessage({
                type: 'bodies-data',
                system:  liveBodySystem,
                bodies:  Object.values(liveBodies),
                signals: liveSignals,
              });
            }
          }

          // ── FSSBodySignals → signals before SA scan ───────────────────────
          if (ev === 'FSSBodySignals') {
            const bodyName = entry.BodyName || '';
            const sigs = (entry.Signals || []).map(s => {
              const t = s.Type_Localised || s.Type || '';
              const c = s.Count != null ? ' \u00D7' + s.Count : '';
              return t + c;
            });
            if (sigs.length) {
              liveSignals[bodyName] = (liveSignals[bodyName] || []).concat(
                sigs.filter(s => !(liveSignals[bodyName] || []).includes(s))
              );
              parentPort.postMessage({
                type: 'bodies-data',
                system:  liveBodySystem,
                bodies:  Object.values(liveBodies),
                signals: liveSignals,
              });
            }
          }

          if (ev === 'Loadout') {
            if (!liveData) liveData = {};
            liveData.ship          = entry.Ship_Localised || entry.Ship;
            liveData.shipName      = entry.ShipName  || '';
            liveData.shipIdent     = entry.ShipIdent || '';
            liveData.maxJumpRange  = entry.MaxJumpRange ? entry.MaxJumpRange.toFixed(2) + ' ly' : null;
            liveData.cargoCapacity = entry.CargoCapacity != null ? entry.CargoCapacity : (liveData.cargoCapacity ?? null);
            if (entry.FuelCapacity != null) {
              liveData.fuelCapacity = typeof entry.FuelCapacity === 'object'
                ? entry.FuelCapacity.Main
                : entry.FuelCapacity;
            }
            liveData.rebuy = entry.Rebuy ?? null;
            // Hull resets to 100% on a fresh Loadout (subsequent HullHealth events update it)
            liveData.hull = 100;
            // Emit immediately so ship switches (SRV, fighter, stored ship) update the UI in real time.
            // partial:true tells journalProvider NOT to cache this — only the final complete
            // emit at end-of-file should be cached, so replayToPage always sends full data.
            parentPort.postMessage({ type: 'live-data', partial: true, data: { ...liveData } });
          }

          // Hull health — fires after combat damage, repairs, and on resurrection
          if (ev === 'HullHealth') {
            if (!liveData) liveData = {};
            // Health field is 0.0–1.0; display as integer percentage
            if (entry.Health != null) liveData.hull = Math.round(entry.Health * 100);
            parentPort.postMessage({ type: 'live-data', partial: true, data: { ...liveData } });
          }

          // Resurrect — player rebought their ship; hull is restored to 100%
          if (ev === 'Resurrect') {
            if (!liveData) liveData = {};
            liveData.hull = 100;
            parentPort.postMessage({ type: 'live-data', partial: true, data: { ...liveData } });
          }

          if (ev === 'LoadGame') {
            if (!liveData) liveData = {};
            liveData.name          = entry.Commander;
            liveData.ship          = entry.Ship_Localised || entry.Ship;
            liveData.shipName      = entry.ShipName  || '';
            liveData.shipIdent     = entry.ShipIdent || '';
            liveData.credits       = entry.Credits;
            liveData.gameMode      = entry.GameMode || 'Open';
            if (entry.FuelLevel    != null) liveData.fuelTotal    = entry.FuelLevel;
            if (entry.FuelCapacity != null) liveData.fuelCapacity = entry.FuelCapacity;
          }

          if (ev === 'FuelScoop' || ev === 'ReservoirReplenished') {
            if (!liveData) liveData = {};
            if (entry.Total    != null) liveData.fuelTotal    = entry.Total;
            if (entry.Capacity != null) liveData.fuelCapacity = entry.Capacity;
          }

          if (ev === 'Docked') {
            if (!liveData) liveData = {};
            liveData.dockedStation      = entry.StationName || null;
            liveData.dockedStationType  = entry.StationType || null;
            liveData.dockedFaction      = entry.StationFaction?.Name || null;
          }

          if (ev === 'Undocked') {
            if (!liveData) liveData = {};
            liveData.dockedStation     = null;
            liveData.dockedStationType = null;
            liveData.dockedFaction     = null;
          }

        }

        // ── PROFILE DATA ──────────────────────────────────────────────
        if (doProfile) {
          if (ev === 'LoadGame') {
            profileIdentity = {
              name:      entry.Commander,
              ship:      entry.Ship_Localised || entry.Ship,
              shipName:  entry.ShipName  || '',
              shipIdent: entry.ShipIdent || '',
              credits:   entry.Credits,
              gameMode:  entry.GameMode || 'Open',
            };
          }

          if (ev === 'Rank') {
            const exobioLevel = entry.Exobiologist != null ? entry.Exobiologist : (entry.Soldier != null ? entry.Soldier : null);
            profileRanks = {
              combat:     { level: entry.Combat     ?? 0, name: getRankName(COMBAT_RANKS,     entry.Combat)     },
              trade:      { level: entry.Trade      ?? 0, name: getRankName(TRADE_RANKS,      entry.Trade)      },
              explore:    { level: entry.Explore    ?? 0, name: getRankName(EXPLORE_RANKS,    entry.Explore)    },
              cqc:        { level: entry.CQC        ?? 0, name: getRankName(CQC_RANKS,        entry.CQC)        },
              empire:     { level: entry.Empire     ?? 0, name: getRankName(EMPIRE_RANKS,     entry.Empire)     },
              federation: { level: entry.Federation ?? 0, name: getRankName(FEDERATION_RANKS, entry.Federation) },
              exobiology: { level: exobioLevel      ?? 0, name: getRankName(EXOBIO_RANKS,     exobioLevel)      },
            };
          }

          if (ev === 'Progress') {
            profileProgress = {
              combat:     entry.Combat,
              trade:      entry.Trade,
              explore:    entry.Explore,
              cqc:        entry.CQC,
              empire:     entry.Empire,
              federation: entry.Federation,
              exobiology: entry.Exobiologist != null ? entry.Exobiologist : null,
            };
          }

          if (ev === 'Reputation') {
            profileReputation = {
              empire:      entry.Empire      ?? 0,
              federation:  entry.Federation  ?? 0,
              alliance:    entry.Alliance    ?? 0,
              independent: entry.Independent ?? 0,
            };
          }

          if (ev === 'Statistics') {
            // Keep the full raw Statistics object — renderer will access sub-keys directly
            profileStats = entry;
          }
        }

      } catch {
        // skip malformed lines
      }

      updatedLastProcessed[fileName] = i;

      if (i % PROGRESS_INTERVAL === 0 || i === totalLines - 1) {
        parentPort.postMessage({
          type: 'progress',
          file: fileName, currentLine: i + 1, totalLines,
          fileIndex: fileIndex + 1, totalFiles
        });
      }
    }
  }

  // ── Emit live-data ────────────────────────────────────────────────────────
  if (doLive && liveData) {
    if (liveData.fuelTotal != null && liveData.fuelCapacity) {
      liveData.fuelPct     = Math.round((liveData.fuelTotal / liveData.fuelCapacity) * 100);
      liveData.fuelDisplay = liveData.fuelTotal.toFixed(1) + ' / ' + liveData.fuelCapacity;
    }
    parentPort.postMessage({ type: 'live-data', data: liveData });
  }

  // ── Emit profile-data ─────────────────────────────────────────────────────
  if (doProfile && (profileIdentity || profileRanks || profileStats)) {
    parentPort.postMessage({
      type: 'profile-data',
      data: {
        identity:   profileIdentity   || {},
        ranks:      profileRanks      || {},
        progress:   profileProgress   || {},
        reputation: profileReputation || {},
        stats:      profileStats      || {},   // raw Statistics event object
      }
    });
  }

  parentPort.postMessage({ type: 'done', updatedLastProcessed });
}

run().catch(err => parentPort.postMessage({ type: 'error', message: err.message }));
