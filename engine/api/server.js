const express = require("express");
const db = require("../db/database");
const config = require("../../config.json");

function start() {
  const app = express();
  app.get("/stats", (req, res) => {
    db.get("SELECT COUNT(*) as count FROM personal_scans", (err, row) => {
      res.json({ scans: row.count });
    });
  });
  app.listen(config.apiPort, () => console.log("API running on port", config.apiPort));
}

module.exports = { start };
