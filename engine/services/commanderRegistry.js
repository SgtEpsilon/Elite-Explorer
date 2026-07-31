/**
 * engine/services/commanderRegistry.js
 *
 * Elite Dangerous writes every commander's journal files into the SAME
 * folder — there is no per-commander subdirectory. Alt accounts (or a
 * second commander slot on one account) are only distinguishable by the
 * `Commander` event (`FID` + `Name`) that Frontier writes near the top of
 * every session file. Historically this app just grabbed whichever
 * Journal.*.log file had the newest mtime and assumed it belonged to "the"
 * commander — fine for one commander, wrong the moment a second exists.
 *
 * This module is the single source of truth for:
 *   - which FIDs exist in the journal folder, and which files belong to each
 *   - which FID is currently ACTIVE (i.e. actually running in-game right now
 *     — whoever owns the single newest journal file)
 *   - which FID the user is currently VIEWING in the app (persisted, so
 *     switching to review an alt's history survives an app restart)
 *
 * Deliberately headless (no electron import at module scope) so it stays
 * testable and mirrors the rest of engine/. Talks outward via eventBus.
 */

const fs   = require('fs');
const path = require('path');
const eventBus = require('../core/eventBus');
const logger   = require('../core/logger');

const { app: electronApp } = (() => { try { return require('electron'); } catch { return {}; } })();
const userDataDir = (electronApp && electronApp.getPath) ? electronApp.getPath('userData') : path.join(__dirname, '../..');
const CONFIG_PATH = path.join(userDataDir, 'config.json');

// Only scan far enough into each file to find the header events — the
// Commander event is always within the first handful of lines Frontier
// writes at session start, long before any bulk data (Materials, Loadout,
// EngineerProgress, etc). Reading the whole file just to find it would be
// wasteful for a folder with months of journals.
const HEADER_SCAN_BYTES = 8192;

let _journalDir = null;
function setJournalDir(dir) {
  const changed = dir !== _journalDir;
  _journalDir = dir;
  if (changed) _initialized = false; // force a rescan against the new folder
}

function readConfig() {
  try { return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8')); } catch { return {}; }
}

function writeConfigPatch(patch) {
  try {
    const cfg = readConfig();
    Object.assign(cfg, patch);
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2));
  } catch (err) {
    logger.error('CMDR', 'Failed to persist config patch', err);
  }
}

// fid -> { fid, name, files: [{ file, fullPath, mtime }], lastSeen }
let _commanders = new Map();
let _activeFid  = null;   // whoever owns the single newest journal file
let _viewingFid = null;   // whoever the app is currently scoped to
let _initialized = false;

// Lazily prime the registry the first time anything asks for data, so a
// caller that runs before start()'s explicit refresh() (or a fresh-boot
// race between the renderer and main) still gets a correct answer instead
// of a false "no commanders" empty result.
function _ensureInit() {
  if (_initialized || !_journalDir) return;
  refresh();
}

function _findCommanderInFile(fullPath) {
  try {
    const fd = fs.openSync(fullPath, 'r');
    const size = fs.fstatSync(fd).size;
    const len = Math.min(size, HEADER_SCAN_BYTES);
    const buffer = Buffer.alloc(len);
    fs.readSync(fd, buffer, 0, len, 0);
    fs.closeSync(fd);

    const lines = buffer.toString('utf8').split('\n');
    let fid = null, name = null;
    for (const line of lines) {
      if (!line.trim()) continue;
      let event;
      try { event = JSON.parse(line); } catch { continue; }
      if (event.event === 'Commander') {
        fid  = event.FID  || fid;
        name = event.Name || name;
      }
      // Older journals (or a truncated header read) may only have LoadGame.
      if (event.event === 'LoadGame') {
        fid  = event.FID       || fid;
        name = event.Commander || name;
      }
      if (fid && name) break;
    }
    return fid ? { fid, name } : null;
  } catch (err) {
    return null;
  }
}

/**
 * Rebuild the FID -> files map from scratch by reading every journal file's
 * header. Cheap enough to call on every new session file (chokidar 'add')
 * since it's a small bounded read per file, not a full parse.
 */
function refresh() {
  if (!_journalDir) return;
  let files;
  try {
    files = fs.readdirSync(_journalDir)
      .filter(f => /^Journal\.\d{4}-\d{2}-\d{2}T\d{6}\.\d+\.log$/.test(f))
      .map(f => {
        const fullPath = path.join(_journalDir, f);
        return { file: f, fullPath, mtime: fs.statSync(fullPath).mtimeMs };
      })
      .sort((a, b) => a.mtime - b.mtime); // oldest -> newest
  } catch (err) {
    logger.error('CMDR', 'Could not read journal dir for commander scan', err);
    return;
  }

  const next = new Map();
  let newestFile = null;

  for (const f of files) {
    const id = _findCommanderInFile(f.fullPath);
    if (!id) continue; // unrecognised/corrupt header — skip rather than misfile it

    if (!next.has(id.fid)) next.set(id.fid, { fid: id.fid, name: id.name, files: [], lastSeen: 0 });
    const entry = next.get(id.fid);
    entry.files.push(f);
    entry.name = id.name || entry.name; // keep the most recently-seen display name
    entry.lastSeen = Math.max(entry.lastSeen, f.mtime);

    if (!newestFile || f.mtime >= newestFile.mtime) newestFile = { ...f, fid: id.fid };
  }

  _commanders = next;
  _initialized = true;
  const prevActive = _activeFid;
  _activeFid = newestFile ? newestFile.fid : null;

  const cfg = readConfig();
  if (cfg.viewingCommanderFid && next.has(cfg.viewingCommanderFid)) {
    _viewingFid = cfg.viewingCommanderFid;
  } else {
    // No saved preference (or it's stale/unknown) — default to whoever's active.
    _viewingFid = _activeFid;
  }

  if (prevActive !== _activeFid) {
    logger.info('CMDR', 'Active commander changed', { fid: _activeFid, name: _activeFid ? next.get(_activeFid)?.name : null });
  }

  eventBus.emit('commanders.updated', list());
}

function list() {
  _ensureInit();
  return [..._commanders.values()]
    .map(c => ({ fid: c.fid, name: c.name, lastSeen: c.lastSeen, fileCount: c.files.length }))
    .sort((a, b) => b.lastSeen - a.lastSeen);
}

function getActiveFid()  { _ensureInit(); return _activeFid; }
function getViewingFid() { _ensureInit(); return _viewingFid || _activeFid; }

function setViewingFid(fid) {
  _ensureInit();
  if (!_commanders.has(fid)) return false;
  _viewingFid = fid;
  writeConfigPatch({ viewingCommanderFid: fid });
  eventBus.emit('commanders.viewingChanged', { fid, isActive: fid === _activeFid });
  return true;
}

/** Sorted oldest -> newest full paths of every journal file for a given FID. */
function getFilesForFid(fid) {
  _ensureInit();
  const entry = _commanders.get(fid);
  if (!entry) return [];
  return [...entry.files].sort((a, b) => a.mtime - b.mtime).map(f => f.fullPath);
}

function getCommanderName(fid) {
  _ensureInit();
  return _commanders.has(fid) ? _commanders.get(fid).name : null;
}

module.exports = {
  setJournalDir,
  refresh,
  list,
  getActiveFid,
  getViewingFid,
  setViewingFid,
  getFilesForFid,
  getCommanderName,
};
