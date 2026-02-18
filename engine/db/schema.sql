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
