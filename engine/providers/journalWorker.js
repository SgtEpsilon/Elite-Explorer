/**
 * journalWorker.js
 * Runs in a Worker Thread — all heavy file reading happens here.
 */

const { workerData, parentPort } = require('worker_threads');
const fs = require('fs');
const path = require('path');

const { files, lastProcessed } = workerData;
const PROGRESS_INTERVAL = 500;

// Rank name lookups
const COMBAT_RANKS    = ['Harmless','Mostly Harmless','Novice','Competent','Expert','Master','Dangerous','Deadly','Elite'];
const TRADE_RANKS     = ['Penniless','Mostly Penniless','Peddler','Dealer','Merchant','Broker','Entrepreneur','Tycoon','Elite'];
const EXPLORE_RANKS   = ['Aimless','Mostly Aimless','Scout','Surveyor','Trailblazer','Pathfinder','Ranger','Pioneer','Elite'];
const CQC_RANKS       = ['Helpless','Mostly Helpless','Amateur','Semi Professional','Professional','Champion','Hero','Gladiator','Elite'];
const EMPIRE_RANKS    = ['None','Outsider','Serf','Master','Squire','Knight','Lord','Baron','Viscount','Count','Earl','Marquis','Duke','Prince','King'];
const FEDERATION_RANKS= ['None','Recruit','Cadet','Midshipman','Petty Officer','Chief Petty Officer','Warrant Officer','Ensign','Lieutenant','Lieutenant Commander','Post Commander','Post Captain','Rear Admiral','Vice Admiral','Admiral'];
const EXOBIO_RANKS    = ['Directionless','Mostly Directionless','Compiler','Collector','Cataloguer','Taxonomist','Ecologist','Geneticist','Elite'];

async function run() {
  const totalFiles = files.length;
  const updatedLastProcessed = { ...lastProcessed };

  // We collect cmdr data as we go — later entries overwrite earlier ones
  // so we always end up with the most recent LoadGame/Rank/etc.
  let cmdrData = null;

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

    const lines = content.split('\n');
    let startIndex = 0;
    if (updatedLastProcessed[fileName] != null) {
      startIndex = updatedLastProcessed[fileName] + 1;
    }

    const totalLines = lines.length;

    for (let i = startIndex; i < totalLines; i++) {
      const line = lines[i].trim();
      if (!line) continue;

      try {
        const entry = JSON.parse(line);

        // ── Existing events ──────────────────────────────────────────
        if (entry.event === 'Scan') {
          parentPort.postMessage({
            type: 'event', event: 'journal.scan',
            data: { system: entry.StarSystem, body: entry.BodyName, bodyType: entry.BodyType, timestamp: entry.timestamp }
          });
        }

        if (entry.event === 'Location') {
          parentPort.postMessage({
            type: 'event', event: 'journal.location',
            data: { system: entry.StarSystem, timestamp: entry.timestamp }
          });
        }

        // ── Commander identity ───────────────────────────────────────
        if (entry.event === 'LoadGame') {
          if (!cmdrData) cmdrData = {};
          cmdrData.name        = entry.Commander;
          cmdrData.ship        = entry.Ship_Localised || entry.Ship;
          cmdrData.shipName    = entry.ShipName || '';
          cmdrData.shipIdent   = entry.ShipIdent || '';
          cmdrData.credits     = entry.Credits;
          cmdrData.loan        = entry.Loan || 0;
          cmdrData.gameMode    = entry.GameMode || 'Open';
          cmdrData.timestamp   = entry.timestamp;
        }

        // ── Ranks ────────────────────────────────────────────────────
        if (entry.event === 'Rank') {
          if (!cmdrData) cmdrData = {};
          cmdrData.ranks = {
            combat:     { level: entry.Combat,     name: COMBAT_RANKS[entry.Combat]     || '?' },
            trade:      { level: entry.Trade,      name: TRADE_RANKS[entry.Trade]       || '?' },
            explore:    { level: entry.Explore,    name: EXPLORE_RANKS[entry.Explore]   || '?' },
            cqc:        { level: entry.CQC,        name: CQC_RANKS[entry.CQC]           || '?' },
            empire:     { level: entry.Empire,     name: EMPIRE_RANKS[entry.Empire]     || '?' },
            federation: { level: entry.Federation, name: FEDERATION_RANKS[entry.Federation] || '?' },
            exobiology: { level: entry.Exobiologist ?? null, name: entry.Exobiologist != null ? (EXOBIO_RANKS[entry.Exobiologist] || '?') : null },
          };
        }

        // ── Rank progress (0–100 %) ──────────────────────────────────
        if (entry.event === 'Progress') {
          if (!cmdrData) cmdrData = {};
          cmdrData.progress = {
            combat:     entry.Combat,
            trade:      entry.Trade,
            explore:    entry.Explore,
            cqc:        entry.CQC,
            empire:     entry.Empire,
            federation: entry.Federation,
          };
        }

        // ── Faction reputation ───────────────────────────────────────
        if (entry.event === 'Reputation') {
          if (!cmdrData) cmdrData = {};
          cmdrData.reputation = {
            empire:     entry.Empire     ?? 0,
            federation: entry.Federation ?? 0,
            alliance:   entry.Alliance   ?? 0,
            independent:entry.Independent?? 0,
          };
        }

        // ── Lifetime statistics ──────────────────────────────────────
        if (entry.event === 'Statistics') {
          if (!cmdrData) cmdrData = {};
          cmdrData.stats = {
            // Exploration
            systemsVisited:     entry.Exploration?.['Systems_Visited']          ?? 0,
            explorationProfit:  entry.Exploration?.['Exploration_Profits']      ?? 0,
            planetsScanned:     entry.Exploration?.['Planets_Scanned_To_Level_3']?? 0,
            efficientScans:     entry.Exploration?.['Efficient_Scans']          ?? 0,
            distanceTravelled:  entry.Exploration?.['Total_Hyperspace_Distance']?? 0,
            jumpsTotal:         entry.Exploration?.['Total_Hyperspace_Jumps']   ?? 0,
            greatestDistance:   entry.Exploration?.['Greatest_Distance_From_Start']?? 0,
            timePlayed:         entry.Exploration?.['Time_Played']              ?? 0,
            // Trading
            tradingProfit:      entry.Trading?.['Market_Profits']               ?? 0,
            tradeTransactions:  entry.Trading?.['Market_Transactions_Count']    ?? 0,
            resourcesCollected: entry.Trading?.['Resources_Collected']          ?? 0,
            // Combat
            bounties:           entry.Combat?.['Bounties_Claimed']              ?? 0,
            bountyCreds:        entry.Combat?.['Bounty_Hunting_Profit']         ?? 0,
            kills:              entry.Combat?.['Kills']                         ?? 0,
            assassinations:     entry.Combat?.['Assassination_Profits']         ?? 0,
            // Mining
            miningProfit:       entry.Mining?.['Mining_Profits']                ?? 0,
            quantityMined:      entry.Mining?.['Quantity_Mined']                ?? 0,
            // Smuggling
            smugglingProfit:    entry.Smuggling?.['Black_Market_Profits']       ?? 0,
            // Search & Rescue
            searchRescueProfit: entry.Search_And_Rescue?.['SearchRescue_Profit']?? 0,
            // Exobiology
            organicsSold:       entry.Exobiology?.['Organics_Sold']             ?? 0,
            exoProfit:          entry.Exobiology?.['Exobiology_Profits']        ?? 0,
          };
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

  // Send the most recent cmdr snapshot we built up
  if (cmdrData) {
    parentPort.postMessage({ type: 'cmdr', data: cmdrData });
  }

  parentPort.postMessage({ type: 'done', updatedLastProcessed });
}

run().catch(err => parentPort.postMessage({ type: 'error', message: err.message }));
