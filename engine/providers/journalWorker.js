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

const { files, lastProcessed, mode = 'all', liveSeed = null } = workerData;
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

  // Live data accumulator (ship, fuel, location, docking).
  // Seeded from journalProvider's cache (the last payload this same live
  // journal produced) so an incremental run — one that only sees the lines
  // written since the last pass — still starts from the true current state
  // instead of blank. See journalProvider.js's buildLiveSeed().
  let liveData = (liveSeed && liveSeed.liveData) ? { ...liveSeed.liveData } : null;

  // Live bodies accumulator — cleared on each FSDJump, built up as Scan events arrive.
  // Keyed by body name so duplicate scans just overwrite.
  let liveBodies     = (liveSeed && liveSeed.liveBodies)     ? { ...liveSeed.liveBodies }  : {};   // bodyName → scan entry
  let liveBodySystem = (liveSeed && liveSeed.liveBodySystem) ? liveSeed.liveBodySystem     : null; // system name these bodies belong to
  let liveSignals    = (liveSeed && liveSeed.liveSignals)    ? { ...liveSeed.liveSignals }  : {};   // bodyName → array of signal strings (bio, geo, stations etc)

  // Live stations accumulator — cleared on each FSDJump alongside liveBodies.
  // Built from Docked (full detail) and ApproachSettlement (name/body only,
  // for settlements seen but not landed at) events. A station you've
  // actually docked at in the current system is ground truth, so this is
  // treated as the highest-priority source when merged with EDSM/Spansh in
  // the renderer.
  let liveStations = (liveSeed && liveSeed.liveStations) ? { ...liveSeed.liveStations } : {};   // stationName → station entry

  // Live missions accumulator — keyed by MissionID so updates overwrite cleanly.
  let liveMissions = (liveSeed && liveSeed.liveMissions) ? { ...liveSeed.liveMissions } : {};  // missionID → mission object

  // Records every time liveBodies/liveStations/liveSignals get wiped, and why.
  // journalProvider.js now runs live mode incrementally (only new lines since
  // the last pass, seeded with the state above) instead of always re-parsing
  // the whole file from line 0, so in normal play this should only ever
  // record 0 or 1 entries per pass — one real FSDJump the player just made.
  // More than one still means a genuine multi-jump gap happened between two
  // passes (e.g. the app was closed mid-session, or a session boundary was
  // just crossed and the file is being read fresh) — this log keeps that
  // visible rather than silent.
  let bodiesClearLog = [];

  // Profile data accumulator (identity, ranks, rep, stats)
  let profileIdentity   = null;
  let profileRanks      = null;
  let profileProgress   = null;
  let profileReputation = null;
  let profileStats      = null;
  let profileEngineers  = {};   // engineerID → engineer record
  let profileMaterials  = null; // { Raw: [], Manufactured: [], Encoded: [] }

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

    // Single place that posts the bodies-data payload. Besides the arrays the
    // renderer expects, this also includes the raw keyed maps (bodiesMap/
    // stationsMap) — journalProvider.js stashes those so the *next* live pass
    // can seed liveBodies/liveStations from them instead of starting empty.
    function postBodiesData() {
      parentPort.postMessage({
        type: 'bodies-data',
        system:      liveBodySystem,
        bodies:      Object.values(liveBodies),
        signals:     liveSignals,
        stations:    Object.values(liveStations),
        bodiesMap:   liveBodies,
        stationsMap: liveStations,
      });
    }

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
        // Buffer the latest location — only emitted once at end-of-file so
        // replaying a full journal doesn't trigger one EDSM lookup per jump.
        // The Location/FSDJump event itself already carries security,
        // allegiance, economy and population straight from the game — no
        // need to wait on EDSM for these, and it means they still show up
        // even if EDSM is unreachable or the system isn't in its database yet.
        if ((ev === 'Location' || ev === 'FSDJump') && doLive) {
          liveData = liveData || {};
          liveData._pendingLocation = {
            system:      entry.StarSystem,
            systemAddress: entry.SystemAddress != null ? entry.SystemAddress : null,
            timestamp:   entry.timestamp,
            coords:      entry.StarPos || null,
            security:    entry.SystemSecurity_Localised || entry.SystemSecurity || null,
            allegiance:  entry.SystemAllegiance || null,
            economy:     entry.SystemEconomy_Localised || entry.SystemEconomy || null,
            government:  entry.SystemGovernment_Localised || entry.SystemGovernment || null,
            population:  entry.Population != null ? entry.Population : null,
          };
        }

        // ── Raw event forwarding for EDDN relay (live watcher only) ──
        // Location and CarrierJump are needed so eddnRelay can track
        // StarPos from the moment the session starts (not just on jumps).
        if (doLive && (ev === 'FSDJump' || ev === 'Docked' || ev === 'Location' || ev === 'CarrierJump' || ev === 'Touchdown')) {
          parentPort.postMessage({ type: 'raw', event: ev, entry });
        }

        // ── Raw event forwarding for exobiologyProvider (live watcher only) ──
        // ScanOrganic fires once per genetic sample taken; CodexEntry fires
        // for every Codex-eligible discovery (we only care about the Biology
        // category here — the provider filters that down further) and tells
        // us whether this is the commander's first-ever log of that trait;
        // SellOrganicData fires once per organism handed in to Vista Genomics
        // and carries the actual credits paid, which is more reliable ground
        // truth than trying to hardcode a per-species value table that drifts
        // out of date whenever Frontier rebalances exobiology payouts.
        if (doLive && (ev === 'ScanOrganic' || ev === 'CodexEntry' || ev === 'SellOrganicData')) {
          parentPort.postMessage({ type: 'raw', event: ev, entry });
        }

        // ── Raw event forwarding for the Materials page (live watcher only) ──
        // The Materials journal event is a full inventory snapshot (Raw/
        // Manufactured/Encoded), not a delta — so journalProvider can patch
        // the cached profile-data payload directly from this single event
        // and push it straight to the renderer, without spawning a whole
        // profile-mode Worker pass just to pick up a materials change.
        if (doLive && ev === 'Materials') {
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
              postBodiesData();
            }
          }

          if (ev === 'FSDJump') {
            if (!liveData) liveData = {};
            liveData.currentSystem = entry.StarSystem;
            liveData.pos           = entry.StarPos ? entry.StarPos.map(n => n.toFixed(2)).join(', ') : null;
            liveData.jumpRange     = entry.JumpDist ? entry.JumpDist.toFixed(2) + ' ly' : null;
            liveData.lastJumpWasFirstDiscovery = (entry.SystemAlreadyDiscovered === false);
            // Clear bodies/stations when entering a new system
            bodiesClearLog.push({
              reason:     'FSDJump',
              prevSystem: liveBodySystem,
              newSystem:  entry.StarSystem,
              timestamp:  entry.timestamp,
            });
            liveBodies     = {};
            liveSignals    = {};
            liveStations   = {};
            liveBodySystem = entry.StarSystem;
            postBodiesData();
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
              // NOTE: the journal's Scan event has no value field at all (no
              // MappedValue/EstimatedValue keys — confirmed against the
              // Frontier journal manual). Value is computed client-side in
              // ui/script.js (computeBodyValue) from class + mass +
              // wasDiscovered/wasMapped instead.
              isScoopable:  entry.StarType ? 'KGBFOAM'.includes(entry.StarType[0]) : false,
              timestamp:    entry.timestamp,
              // "AutoScan" = the game auto-filled this body's data (arrival
              // star, or a body someone else already catalogued) — the CMDR
              // never actually ran FSS or the DSS probe on it. "Detailed" is
              // a real FSS reticle scan. Captured but not yet used to filter
              // what shows up as a "Scan Value" — see chat for the open
              // question on which of these should count.
              scanType:     entry.ScanType || null,
            };
            postBodiesData();
          }

          // ── FSSDiscoveryScan (Discovery Scanner fired) ───────────────────────
          // Flush current bodies immediately and signal edsmClient to re-fetch,
          // so the System Bodies panel gets the freshest data right away.
          if (ev === 'FSSDiscoveryScan') {
            liveBodySystem = entry.SystemName || liveBodySystem;
            postBodiesData();
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
              postBodiesData();
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
              postBodiesData();
            }
          }

          // ── Docked → full station detail, straight from the game ──────────
          // A station you've actually docked at this session is ground truth —
          // outranks both EDSM and Spansh when merged in the renderer.
          if (ev === 'Docked') {
            liveBodySystem = entry.StarSystem || liveBodySystem;
            const services = entry.StationServices || [];
            const key = entry.StationName || ('MarketID:' + entry.MarketID);
            liveStations[key] = {
              name:              entry.StationName || '?',
              type:              entry.StationType || 'Station',
              distanceToArrival: entry.DistFromStarLS != null ? entry.DistFromStarLS : null,
              haveMarket:        services.indexOf('Commodities') !== -1 || services.indexOf('Market') !== -1,
              haveShipyard:      services.indexOf('Shipyard') !== -1,
              haveOutfitting:    services.indexOf('Outfitting') !== -1,
              otherServices:     services,
              controllingFaction: entry.StationFaction && entry.StationFaction.Name
                ? { name: entry.StationFaction.Name } : null,
              body: entry.BodyName ? { name: entry.BodyName } : null,
              updateTime: entry.timestamp || null,
              source: 'journal',
            };
            postBodiesData();
          }

          // ── ApproachSettlement → lightweight entry for settlements seen ───
          // but not landed at. Only fills in if Docked hasn't already given us
          // a richer record for the same name — never downgrades it.
          if (ev === 'ApproachSettlement') {
            const key = entry.Name || '';
            if (key && !liveStations[key]) {
              liveStations[key] = {
                name:              key,
                type:              'Settlement',
                distanceToArrival: null,
                haveMarket:        false,
                haveShipyard:      false,
                haveOutfitting:    false,
                otherServices:     [],
                controllingFaction: null,
                body: entry.BodyName ? { name: entry.BodyName } : null,
                updateTime: entry.timestamp || null,
                source: 'journal',
              };
              postBodiesData();
            }

            // ── Guardian site detection ─────────────────────────────────────
            // Whether the Name matches a $Ancient_* Guardian identifier is
            // decided in ONE place — guardianSitesService.parseApproachSettlementName
            // — so this worker doesn't duplicate that classification table; it
            // just forwards the raw fields the main-thread listener needs.
            // ApproachSettlement itself has no StarSystem field, so we tack on
            // liveBodySystem (the system this worker is already tracking) —
            // needed later to key a Canonn lookup by system name.
            if (key && key.startsWith('$Ancient')) {
              parentPort.postMessage({
                type: 'event',
                event: 'journal.approachSettlement',
                data: {
                  name:          key,
                  systemName:    liveBodySystem,
                  systemAddress: entry.SystemAddress != null ? entry.SystemAddress : null,
                  bodyId:        entry.BodyID != null ? entry.BodyID : null,
                  bodyName:      entry.BodyName || null,
                  latitude:      entry.Latitude  != null ? entry.Latitude  : null,
                  longitude:     entry.Longitude != null ? entry.Longitude : null,
                  timestamp:     entry.timestamp || null,
                },
              });
            }
          }

          // ── CodexEntry (Guardian fallback) ────────────────────────────────
          // Secondary location fix for a site whose ApproachSettlement wasn't
          // captured (e.g. scanned a Codex entry at range). Never classifies
          // siteType by itself — only ApproachSettlement's $Ancient_* Name can
          // do that (see guardianSitesService.parseApproachSettlementName) —
          // this just supplies/confirms an origin lat/long for an already-known
          // site.
          if (ev === 'CodexEntry' && entry.SubCategory === '$Codex_SubCategory_Guardian;') {
            parentPort.postMessage({
              type: 'event',
              event: 'journal.codexGuardian',
              data: {
                subCategory:   entry.SubCategory,
                name:          entry.Name || null,
                nameLocalised: entry.Name_Localised || null,
                systemAddress: entry.SystemAddress != null ? entry.SystemAddress : null,
                bodyId:        entry.BodyID != null ? entry.BodyID : null,
                latitude:      entry.Latitude  != null ? entry.Latitude  : null,
                longitude:     entry.Longitude != null ? entry.Longitude : null,
                timestamp:     entry.timestamp || null,
              },
            });
          }

          // ── Fleet Carrier — order/trade events ──────────────────────────
          // These exist purely to give capiProvider an early, event-driven
          // cue about our OWN carrier: journal data can't see other crew's
          // actions or the carrier's true stock levels (that's still cAPI's
          // job), but it sees our own docking, order changes, and trades
          // instantly instead of on the next 5-minute /fleetcarrier poll.
          if (ev === 'Docked' && entry.StationType === 'FleetCarrier') {
            parentPort.postMessage({
              type: 'carrier-event',
              data: { kind: 'docked', carrierId: entry.MarketID, timestamp: entry.timestamp }
            });
          }

          // CarrierTradeOrder fires only when *we* (the carrier owner) set or
          // cancel a buy/sell order from the Carrier Management panel — its
          // fields map 1:1 onto the /fleetcarrier orders.commodities shape,
          // so capiProvider can patch its cache directly from this.
          if (ev === 'CarrierTradeOrder') {
            parentPort.postMessage({
              type: 'carrier-event',
              data: {
                kind:               'tradeOrder',
                carrierId:          entry.CarrierID,
                commodity:          entry.Commodity,
                commodityLocalised: entry.Commodity_Localised || entry.Commodity,
                purchaseOrder:      entry.PurchaseOrder != null ? entry.PurchaseOrder : null,
                saleOrder:          entry.SaleOrder      != null ? entry.SaleOrder      : null,
                cancelTrade:        !!entry.CancelTrade,
                price:              entry.Price != null ? entry.Price : null,
                blackMarket:        !!entry.BlackMarket,
                timestamp:          entry.timestamp,
              }
            });
          }

          // MarketBuy/MarketSell/CargoTransfer while docked at our own
          // carrier change its hold contents, but — unlike CarrierTradeOrder
          // — nothing here tells us the resulting stock number, so we only
          // use these as a "go refresh soon" nudge rather than patching data.
          if ((ev === 'MarketBuy' || ev === 'MarketSell' || ev === 'CargoTransfer') &&
              liveData && liveData.dockedStationType === 'FleetCarrier') {
            parentPort.postMessage({
              type: 'carrier-event',
              data: { kind: 'trade', event: ev, timestamp: entry.timestamp }
            });
          }

          if (ev === 'Loadout') {
            if (!liveData) liveData = {};
            liveData.ship          = entry.Ship_Localised || entry.Ship;
            liveData.shipRaw       = entry.Ship || '';
            liveData.shipName      = entry.ShipName  || '';
            liveData.shipIdent     = entry.ShipIdent || '';
            liveData.maxJumpRange    = entry.MaxJumpRange ? entry.MaxJumpRange.toFixed(2) + ' ly' : null;
            liveData.maxJumpRangeRaw = entry.MaxJumpRange || 0;
            liveData.cargoCapacity = entry.CargoCapacity != null ? entry.CargoCapacity : (liveData.cargoCapacity ?? null);
            liveData.unladenMass   = entry.UnladenMass   != null ? entry.UnladenMass   : null;
            liveData.hullValue     = entry.HullValue     != null ? entry.HullValue     : null;
            liveData.modulesValue  = entry.ModulesValue  != null ? entry.ModulesValue  : null;
            liveData.rebuy         = entry.Rebuy         != null ? entry.Rebuy         : null;
            liveData.modules       = entry.Modules       || [];
            if (entry.FuelCapacity != null) {
              liveData.fuelCapacity = typeof entry.FuelCapacity === 'object'
                ? entry.FuelCapacity.Main
                : entry.FuelCapacity;
            }
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

          // ── MISSIONS ──────────────────────────────────────────────────────
          if (ev === 'MissionAccepted') {
            liveMissions[entry.MissionID] = {
              id:                  entry.MissionID,
              name:                entry.LocalisedName || entry.Name || 'Unknown Mission',
              internalName:        entry.Name || '',
              status:              'Active',
              faction:             entry.Faction         || null,
              targetFaction:       entry.TargetFaction   || null,
              influence:           entry.Influence       || null,
              reputation:          entry.Reputation      || null,
              reward:              entry.Reward          || null,
              commodity:           entry.Commodity_Localised || entry.Commodity || null,
              count:               entry.Count           || null,
              target:              entry.Target          || null,
              targetType:          entry.TargetType_Localised || entry.TargetType || null,
              destinationSystem:   entry.DestinationSystem  || null,
              destinationStation:  entry.DestinationStation || null,
              newEndeavour:        entry.NewEndeavour    || false,
              expiry:              entry.Expiry          || null,  // ISO string
              acceptedTimestamp:   entry.timestamp       || null,
            };
            parentPort.postMessage({ type: 'missions-data', missions: liveMissions });
          }

          if (ev === 'MissionCompleted') {
            if (liveMissions[entry.MissionID]) {
              liveMissions[entry.MissionID].status        = 'Complete';
              liveMissions[entry.MissionID].reward        = entry.Reward ?? liveMissions[entry.MissionID].reward;
              liveMissions[entry.MissionID].doneTimestamp = entry.timestamp || null;
            } else {
              liveMissions[entry.MissionID] = {
                id: entry.MissionID,
                name: entry.LocalisedName || entry.Name || 'Mission',
                internalName: entry.Name || '',
                status: 'Complete',
                reward: entry.Reward || null,
                doneTimestamp: entry.timestamp || null,
              };
            }
            parentPort.postMessage({ type: 'missions-data', missions: liveMissions });
          }

          if (ev === 'MissionFailed') {
            if (liveMissions[entry.MissionID]) {
              liveMissions[entry.MissionID].status        = 'Failed';
              liveMissions[entry.MissionID].doneTimestamp = entry.timestamp || null;
            } else {
              liveMissions[entry.MissionID] = {
                id: entry.MissionID,
                name: entry.Name || 'Mission',
                internalName: entry.Name || '',
                status: 'Failed',
                doneTimestamp: entry.timestamp || null,
              };
            }
            parentPort.postMessage({ type: 'missions-data', missions: liveMissions });
          }

          if (ev === 'MissionAbandoned') {
            if (liveMissions[entry.MissionID]) {
              liveMissions[entry.MissionID].status        = 'Abandoned';
              liveMissions[entry.MissionID].doneTimestamp = entry.timestamp || null;
            }
            parentPort.postMessage({ type: 'missions-data', missions: liveMissions });
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

          // ── EngineerProgress — full array (on login) or single update ──────
          if (ev === 'EngineerProgress') {
            if (Array.isArray(entry.Engineers)) {
              // Full snapshot from login — replace everything
              profileEngineers = {};
              entry.Engineers.forEach(eng => {
                profileEngineers[eng.EngineerID] = {
                  name:         eng.Engineer,
                  id:           eng.EngineerID,
                  progress:     eng.Progress,
                  rank:         eng.Rank         || null,
                  rankProgress: eng.RankProgress || null,
                };
              });
            } else if (entry.Engineer && entry.EngineerID) {
              // Single engineer update
              profileEngineers[entry.EngineerID] = {
                name:         entry.Engineer,
                id:           entry.EngineerID,
                progress:     entry.Progress,
                rank:         entry.Rank         || null,
                rankProgress: entry.RankProgress || null,
              };
            }
          }

          // ── Materials — full inventory snapshot ───────────────────────────
          if (ev === 'Materials') {
            profileMaterials = {
              Raw:          entry.Raw          || [],
              Manufactured: entry.Manufactured || [],
              Encoded:      entry.Encoded      || [],
            };
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
    // Emit the most recent location exactly once — buffered above to avoid one
    // EDSM fetch per FSDJump when replaying a full journal file on startup.
    if (liveData._pendingLocation) {
      parentPort.postMessage({ type: 'event', event: 'journal.location', data: liveData._pendingLocation });
      delete liveData._pendingLocation;
    }
    parentPort.postMessage({ type: 'live-data', data: liveData });
  }

  // ── Emit bodies-clear summary ─────────────────────────────────────────────
  // One message per run() (not per clear) so a long-session replay doesn't
  // spam the log — but it still carries every individual transition for
  // anyone who wants the full detail (exported debug log).
  if (doLive && bodiesClearLog.length > 0) {
    parentPort.postMessage({
      type: 'bodies-clear-summary',
      data: {
        count:        bodiesClearLog.length,
        transitions:  bodiesClearLog,
        finalSystem:  liveBodySystem,
      }
    });
  }

  // ── Emit missions-data ────────────────────────────────────────────────────
  if (doLive && Object.keys(liveMissions).length > 0) {
    parentPort.postMessage({ type: 'missions-data', missions: liveMissions });
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
        engineers:  Object.values(profileEngineers),
        materials:  profileMaterials  || { Raw: [], Manufactured: [], Encoded: [] },
      }
    });
  }

  parentPort.postMessage({ type: 'done', updatedLastProcessed });
}

run().catch(err => parentPort.postMessage({ type: 'error', message: err.message }));
