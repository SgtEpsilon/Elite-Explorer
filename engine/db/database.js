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
    CREATE TABLE IF NOT EXISTS commander_state (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      current_system TEXT,
      updated_at TEXT
    );
  `);

  _ready = true;
  // Flush any writes that arrived before we were ready
  _queue.forEach(fn => fn(_db));
  _queue.length = 0;

  console.log('Database ready at', dbPath);
}

// Persist the in-memory DB to disk
function save() {
  if (!_db) return;
  const data = _db.export();
  fs.writeFileSync(getDbPath(), Buffer.from(data));
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
      save();
    } else {
      _queue.push(d => { if (hasParams) d.run(sql, params); else d.run(sql); save(); });
    }
  },
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
