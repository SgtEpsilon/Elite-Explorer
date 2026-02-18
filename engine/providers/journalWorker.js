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

async function run() {
  const totalFiles            = files.length;
  const updatedLastProcessed  = { ...lastProcessed };

  // Live data accumulator (ship, fuel, location, docking)
  let liveData = null;

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

        // ── Raw event forwarding for EDDN (live watcher only) ─────────
        if (doLive && (ev === 'FSDJump' || ev === 'Docked')) {
          parentPort.postMessage({ type: 'raw', event: ev, entry });
        }

        // ── LIVE DATA ─────────────────────────────────────────────────
        if (doLive) {
          if (ev === 'Location') {
            if (!liveData) liveData = {};
            liveData.currentSystem = entry.StarSystem;
            liveData.pos = entry.StarPos ? entry.StarPos.map(n => n.toFixed(2)).join(', ') : null;
          }

          if (ev === 'FSDJump') {
            if (!liveData) liveData = {};
            liveData.currentSystem = entry.StarSystem;
            liveData.pos           = entry.StarPos ? entry.StarPos.map(n => n.toFixed(2)).join(', ') : null;
            liveData.jumpRange     = entry.JumpDist ? entry.JumpDist.toFixed(2) + ' ly' : null;
            liveData.lastJumpWasFirstDiscovery = (entry.SystemAlreadyDiscovered === false);
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

          if (ev === 'ShipTargeted' && entry.ScanStage === 3) {
            // hull health updates from targeting (not critical for live, skip)
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
            profileRanks = {
              combat:     { level: entry.Combat,     name: COMBAT_RANKS[entry.Combat]     || '?' },
              trade:      { level: entry.Trade,      name: TRADE_RANKS[entry.Trade]       || '?' },
              explore:    { level: entry.Explore,    name: EXPLORE_RANKS[entry.Explore]   || '?' },
              cqc:        { level: entry.CQC,        name: CQC_RANKS[entry.CQC]           || '?' },
              empire:     { level: entry.Empire,     name: EMPIRE_RANKS[entry.Empire]     || '?' },
              federation: { level: entry.Federation, name: FEDERATION_RANKS[entry.Federation] || '?' },
              exobiology: entry.Exobiologist != null
                ? { level: entry.Exobiologist, name: EXOBIO_RANKS[entry.Exobiologist] || '?' }
                : null,
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
