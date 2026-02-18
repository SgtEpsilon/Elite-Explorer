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
    if (_ready) {
      _db.run(sql, params);
      save();
    } else {
      _queue.push(d => { d.run(sql, params); save(); });
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
