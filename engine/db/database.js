const sqlite3 = require("sqlite3").verbose();
const fs = require("fs");
const path = require("path");

const dbPath = path.join(__dirname, "../../explorer.db");
const schemaPath = path.join(__dirname, "schema.sql");

const db = new sqlite3.Database(dbPath);

const schema = fs.readFileSync(schemaPath, "utf8");
db.exec(schema);

module.exports = db;
