const db = require('../db/database');
const eventBus = require('./eventBus');
const journalProvider = require('../providers/journalProvider');
const logger = require('./logger');

function start() {
  logger.info('ENGINE', 'Engine core starting — wiring eventBus listeners');
  eventBus.on('journal.scan', (data) => {
    db.run(
      `INSERT INTO personal_scans (system_name, body_name, body_type, timestamp)
       VALUES (?, ?, ?, ?)`,
      [data.system ?? null, data.body ?? null, data.bodyType ?? null, data.timestamp ?? null]
    );
  });

  eventBus.on('journal.location', (data) => {
    db.run(
      `INSERT OR REPLACE INTO commander_state (id, current_system, updated_at)
       VALUES (1, ?, ?)`,
      [data.system ?? null, data.timestamp ?? null]
    );
  });

  journalProvider.start();
}

module.exports = { start };
