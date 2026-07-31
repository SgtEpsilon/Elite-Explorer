const fs = require('fs');
const path = require('path');
const initSqlJs = require('sql.js');

// sql.js stores the DB as a plain binary file on disk.
// We read it at startup, keep it in memory while running, and flush it back
// to disk after every write. No native compilation needed — it's pure WASM.

function getDbPath() {
  try {
    const { app } = require('electron');
    if (app && app.getPath) return path.join(app.getPath('userData'), 'explorer.db');
  } catch {}
  return path.join(__dirname, '../../explorer.db');
}

// We export a promise that resolves to the db instance.
// Callers do: const { db } = require('./database'); then await db
// But since engine.js and server.js need it synchronously at module load time,
// we use a wrapper that queues operations until ready.

let _db = null;
const _queue = [];
let _ready = false;

function _columnNames(table) {
  const res = _db.exec(`PRAGMA table_info(${table})`);
  if (!res.length) return [];
  return res[0].values.map(row => row[1]);
}

function _tableExists(table) {
  const res = _db.exec(
    `SELECT name FROM sqlite_master WHERE type='table' AND name='${table}'`
  );
  return res.length > 0 && res[0].values.length > 0;
}

function _migrateForMultiCommander() {
  if (!_columnNames('personal_scans').includes('cmdr_fid')) {
    _db.run('ALTER TABLE personal_scans ADD COLUMN cmdr_fid TEXT');
  }

  const needsRecreate = _tableExists('commander_state') && !_columnNames('commander_state').includes('fid');

  if (needsRecreate) {
    let legacyRow = null;
    try {
      const res = _db.exec('SELECT current_system, updated_at FROM commander_state WHERE id = 1');
      if (res.length && res[0].values.length) {
        const row = res[0].values[0];
        legacyRow = { current_system: row[0], updated_at: row[1] };
      }
    } catch (e) { /* old table may not even have rows */ }

    _db.run('DROP TABLE commander_state');
    _db.run(
      'CREATE TABLE commander_state (fid TEXT PRIMARY KEY, cmdr_name TEXT, current_system TEXT, updated_at TEXT);'
    );
    if (legacyRow) {
      _db.run(
        'INSERT INTO commander_state (fid, cmdr_name, current_system, updated_at) VALUES (?, ?, ?, ?)',
        ['legacy-unknown', null, legacyRow.current_system, legacyRow.updated_at]
      );
    }
  } else {
    _db.run(
      'CREATE TABLE IF NOT EXISTS commander_state (fid TEXT PRIMARY KEY, cmdr_name TEXT, current_system TEXT, updated_at TEXT);'
    );
  }
}

async function init() {
  const SQL = await initSqlJs();
  const dbPath = getDbPath();

  // Load existing DB file, or start fresh
  let fileBuffer = null;
  if (fs.existsSync(dbPath)) {
    fileBuffer = fs.readFileSync(dbPath);
  }

  _db = fileBuffer ? new SQL.Database(fileBuffer) : new SQL.Database();

  _db.run(`
    CREATE TABLE IF NOT EXISTS personal_scans (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      system_name TEXT,
      body_name TEXT,
      body_type TEXT,
      estimated_value INTEGER,
      timestamp TEXT
    );
  `);

  _migrateForMultiCommander();

  _ready = true;
  // Flush any writes that arrived before we were ready
  _queue.forEach(fn => fn(_db));
  _queue.length = 0;

  console.log('Database ready at', dbPath);
}

// Persist the in-memory DB to disk.
//
// PERF: sql.js has no incremental persistence — export() always serializes
// the *entire* database to a fresh buffer, however big it's grown. The old
// code called this synchronously (via writeFileSync) after every single
// db.run(), which meant every journal scan event during play (FSS/DSS can
// fire dozens in a few seconds) did a full O(n)-sized blocking export+write
// on the Electron *main* process — the same thread that services all IPC
// and window messaging. As personal_scans grows over weeks of play this
// gets slower and slower, and every scan stutters the whole app.
//
// Fix: mark the DB dirty and flush it on a short debounce timer instead of
// on every write. Bursts of inserts (mapping a whole system) now cost one
// export+write instead of one per row. The write itself is also async
// (fs.promises.writeFile) so it never blocks the event loop, and it goes to
// a temp file + rename so a mid-write crash can't corrupt explorer.db.
let _saveTimer = null;
let _dirty = false;
let _saving = false;
const SAVE_DEBOUNCE_MS = 2000;

function scheduleSave() {
  _dirty = true;
  if (_saveTimer) return;
  _saveTimer = setTimeout(flush, SAVE_DEBOUNCE_MS);
  // Don't let a pending save keep the process alive on its own.
  if (_saveTimer.unref) _saveTimer.unref();
}

async function flush() {
  _saveTimer = null;
  if (!_db || !_dirty || _saving) return;
  _saving = true;
  _dirty = false;
  try {
    const data = _db.export();
    const dbPath = getDbPath();
    const tmpPath = dbPath + '.tmp';
    await fs.promises.writeFile(tmpPath, Buffer.from(data));
    await fs.promises.rename(tmpPath, dbPath);
  } catch (err) {
    console.error('Database save failed:', err);
    _dirty = true; // retry on the next write or flush
  } finally {
    _saving = false;
  }
}

// Synchronous last-resort flush for app shutdown (before-quit), where an
// async write might not get a chance to finish. Only used at exit time.
function flushSync() {
  if (!_db || !_dirty) return;
  try {
    if (_saveTimer) { clearTimeout(_saveTimer); _saveTimer = null; }
    const data = _db.export();
    fs.writeFileSync(getDbPath(), Buffer.from(data));
    _dirty = false;
  } catch (err) {
    console.error('Database sync flush failed:', err);
  }
}

// Thin wrapper so callers don't need to worry about async init
const db = {
  run(sql, params = []) {
    // IMPORTANT: sql.js's run(sql, params) only executes the FIRST statement
    // in `sql` once a params argument is present — even an empty array.
    // run(sql) with no second argument at all is what lets a semicolon-
    // separated multi-statement string (e.g. a schema block with several
    // CREATE TABLEs) run in full. So only pass params through when there
    // actually are some; a param-less call falls back to the no-arg form.
    const hasParams = Array.isArray(params) && params.length > 0;
    if (_ready) {
      if (hasParams) _db.run(sql, params); else _db.run(sql);
      scheduleSave();
    } else {
      _queue.push(d => { if (hasParams) d.run(sql, params); else d.run(sql); scheduleSave(); });
    }
  },
  // Force an immediate write (rarely needed — e.g. right before quitting).
  flush,
  flushSync,
  get(sql, params = []) {
    if (!_ready) return null;
    const stmt = _db.prepare(sql);
    stmt.bind(params);
    if (stmt.step()) {
      const row = stmt.getAsObject();
      stmt.free();
      return row;
    }
    stmt.free();
    return null;
  },
  all(sql, params = []) {
    if (!_ready) return [];
    const results = [];
    const stmt = _db.prepare(sql);
    stmt.bind(params);
    while (stmt.step()) results.push(stmt.getAsObject());
    stmt.free();
    return results;
  }
};

// Kick off async init immediately
init().catch(err => console.error('DB init failed:', err));

module.exports = db;
