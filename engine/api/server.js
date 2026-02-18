const express = require('express');
const db = require('../db/database');
const config = require('../../config.json');

function start() {
  const app = express();

  app.get('/stats', (req, res) => {
    try {
      const row = db.get('SELECT COUNT(*) as count FROM personal_scans');
      res.json({ scans: row ? row.count : 0 });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  app.listen(config.apiPort, () => console.log('API running on port', config.apiPort));
}

module.exports = { start };
