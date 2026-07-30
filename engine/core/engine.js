const db = require('../db/database');
const eventBus = require('./eventBus');
const journalProvider = require('../providers/journalProvider');
const guardianSitesService = require('../services/guardianSitesService');
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

  // Guardian sites (see engine/services/guardianSitesService.js) — caught
  // individually so a bad event never takes down the other eventBus listeners.
  eventBus.on('journal.approachSettlement', (data) => {
    try { guardianSitesService.handleApproachSettlementEvent(data); }
    catch (err) { logger.error('GUARDIAN', 'approachSettlement handling failed', err.message); }
  });

  eventBus.on('journal.codexGuardian', (data) => {
    try { guardianSitesService.handleCodexEntryEvent(data); }
    catch (err) { logger.error('GUARDIAN', 'codexGuardian handling failed', err.message); }
  });

  journalProvider.start();
}

module.exports = { start };
