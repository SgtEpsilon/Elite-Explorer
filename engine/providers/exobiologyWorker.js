/**
 * exobiologyWorker.js
 * Standalone worker thread — mirrors historyWorker.js's shape.
 * Reads every journal file it is given and builds a lifetime genus/species
 * catalog from three event types:
 *
 *   ScanOrganic     — fires once per genetic sample. Tells us what you've
 *                      found, where, and when.
 *   CodexEntry       — fires for Codex-eligible discoveries. We only keep the
 *                      Biology category. IsNewEntry tells us this is the
 *                      first time *this commander* has ever logged that
 *                      exact trait — that's what unlocks the "first logged"
 *                      5x payout, so we surface it as the first-discovery flag.
 *   SellOrganicData  — fires once per organism hand-in at Vista Genomics (or
 *                      a Frontier/Genetics station). Carries the *actual*
 *                      credits paid (Value + Bonus) — ground truth, so we
 *                      don't need to hand-maintain a per-species value table
 *                      that goes stale every time Frontier rebalances payouts.
 */

const { workerData, parentPort } = require('worker_threads');
const fs   = require('fs');
const path = require('path');

const { files } = workerData;
const PROGRESS_INTERVAL = 250;

// Build a stable catalog key out of whatever identifying fields an event has.
// Not every event carries a Variant (some species don't have one), so the
// key degrades gracefully.
function catalogKey(genus, species, variant) {
  return [genus || '?', species || '?', variant || ''].join('|');
}

function makeEntry(genus, genusName, species, speciesName, variant, variantName) {
  return {
    genus, genusName,
    species, speciesName,
    variant: variant || null,
    variantName: variantName || null,
    firstSystem: null,
    firstBody: null,
    firstSeenAt: null,
    scansLogged: 0,      // total ScanOrganic events seen for this species (any ScanType)
    individualsFound: 0, // distinct organisms started (ScanType === 'Log')
    timesSold: 0,        // total individuals cashed in via SellOrganicData
    creditsEarned: 0,    // sum of (Value + Bonus) across all sales
    firstDiscovery: false, // true if any matching CodexEntry had IsNewEntry
  };
}

async function run() {
  const totalFiles = files.length;
  const catalog = {}; // catalogKey -> entry

  // ScanOrganic only carries a numeric Body ID + SystemAddress, not names —
  // so we track location context as we walk the file, the same way the game
  // itself resolves "what body am I standing on" from earlier events.
  let currentSystem  = null;
  let bodyNamesById   = {}; // BodyID -> body name, refreshed on system change

  function touch(genus, genusName, species, speciesName, variant, variantName) {
    const key = catalogKey(genus, species, variant);
    if (!catalog[key]) catalog[key] = makeEntry(genus, genusName, species, speciesName, variant, variantName);
    return catalog[key];
  }

  for (let fileIndex = 0; fileIndex < totalFiles; fileIndex++) {
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
    const totalLines = lines.length;

    for (let i = 0; i < totalLines; i++) {
      const line = lines[i].trim();
      if (!line) continue;

      try {
        const entry = JSON.parse(line);
        const ev    = entry.event;

        // Track location context — FSDJump/Location reset the system and the
        // body-name cache; Touchdown/ApproachBody/SAASignalsFound all carry a
        // BodyID + Body name pair we can use to resolve ScanOrganic's numeric
        // Body field back to something readable.
        if (ev === 'FSDJump' || ev === 'Location') {
          currentSystem  = entry.StarSystem || currentSystem;
          bodyNamesById  = {};
        }
        if ((ev === 'Touchdown' || ev === 'ApproachBody' || ev === 'SAASignalsFound' || ev === 'Scan')
            && entry.BodyID != null && entry.Body) {
          bodyNamesById[entry.BodyID] = entry.Body;
        }

        if (ev === 'ScanOrganic') {
          const rec = touch(
            entry.Genus, entry.Genus_Localised,
            entry.Species, entry.Species_Localised,
            entry.Variant, entry.Variant_Localised
          );
          rec.scansLogged++;
          if (entry.ScanType === 'Log') rec.individualsFound++;
          if (!rec.firstSeenAt) {
            rec.firstSeenAt = entry.timestamp || null;
            rec.firstSystem = currentSystem;
            rec.firstBody   = bodyNamesById[entry.Body] || (entry.Body != null ? ('Body ' + entry.Body) : null);
          }
        }

        // Only the Biology category matters here — CodexEntry also fires for
        // geology, Guardian ruins, human sites, etc.
        if (ev === 'CodexEntry' && entry.Category === '$Codex_Category_Biology;' && entry.IsNewEntry) {
          // CodexEntry doesn't split Genus/Species/Variant the way ScanOrganic
          // does — Name/Name_Localised is the full species (sometimes variant)
          // name. Match it against anything we've already logged this session
          // by localized species/variant name since that's the only common key.
          const localisedName = entry.Name_Localised || entry.Name || null;
          if (localisedName) {
            Object.keys(catalog).forEach(k => {
              const rec = catalog[k];
              if (rec.variantName === localisedName || rec.speciesName === localisedName) {
                rec.firstDiscovery = true;
              }
            });
          }
        }

        if (ev === 'SellOrganicData' && Array.isArray(entry.BioData)) {
          entry.BioData.forEach(bio => {
            const rec = touch(
              bio.Genus, bio.Genus_Localised,
              bio.Species, bio.Species_Localised,
              bio.Variant, bio.Variant_Localised
            );
            rec.timesSold++;
            rec.creditsEarned += (bio.Value || 0) + (bio.Bonus || 0);
          });
        }
      } catch {
        // skip malformed lines
      }

      if (i % PROGRESS_INTERVAL === 0 || i === totalLines - 1) {
        parentPort.postMessage({
          type: 'progress',
          file: fileName,
          currentLine: i + 1,
          totalLines,
          fileIndex: fileIndex + 1,
          totalFiles,
          speciesFound: Object.keys(catalog).length,
        });
      }
    }
  }

  parentPort.postMessage({ type: 'done', catalog: Object.values(catalog) });
}

run().catch(err => parentPort.postMessage({ type: 'error', message: err.message }));
