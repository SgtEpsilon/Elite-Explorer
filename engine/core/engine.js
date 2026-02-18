const db = require('../db/database');
const eventBus = require('./eventBus');
const journalProvider = require('../providers/journalProvider');

function start() {
  eventBus.on('journal.scan', (data) => {
    db.run(
      `INSERT INTO personal_scans (system_name, body_name, body_type, timestamp)
       VALUES (?, ?, ?, ?)`,
      [data.system, data.body, data.type, data.timestamp]
    );
  });

  eventBus.on('journal.location', (data) => {
    db.run(
      `INSERT OR REPLACE INTO commander_state (id, current_system, updated_at)
       VALUES (1, ?, ?)`,
      [data.system, data.timestamp]
    );
  });

  journalProvider.start();
}

module.exports = { start };
