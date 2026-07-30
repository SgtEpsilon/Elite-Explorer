/**
 * engine/core/env.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Minimal .env loader — no dependency on the `dotenv` package, since the app
 * has almost no external deps and this is the only thing we'd need it for.
 *
 * Load order for any given key:
 *   1. A real environment variable (e.g. set by CI/CD when building releases,
 *      or set in your shell for local `npm start`). Always wins if present —
 *      never overwritten by the .env file.
 *   2. A `.env` file in the project root (gitignored — see .gitignore).
 *      Format: KEY=value, one per line, '#' comments and blank lines ignored.
 *
 * Neither of these is ever committed to source control. See .env.example
 * for the template that IS committed, showing what keys are expected.
 * ─────────────────────────────────────────────────────────────────────────────
 */

const fs   = require('fs');
const path = require('path');

let _loaded = false;

function loadEnvFile() {
  if (_loaded) return;
  _loaded = true;

  const envPath = path.join(__dirname, '..', '..', '.env');
  if (!fs.existsSync(envPath)) return;

  try {
    const lines = fs.readFileSync(envPath, 'utf8').split('\n');
    for (const rawLine of lines) {
      const line = rawLine.trim();
      if (!line || line.startsWith('#')) continue;

      const eq = line.indexOf('=');
      if (eq === -1) continue;

      const key = line.slice(0, eq).trim();
      let value = line.slice(eq + 1).trim();

      // Strip matching surrounding quotes, if present.
      if ((value.startsWith('"') && value.endsWith('"')) ||
          (value.startsWith("'") && value.endsWith("'"))) {
        value = value.slice(1, -1);
      }

      // Never let the .env file clobber a real environment variable.
      if (process.env[key] === undefined) {
        process.env[key] = value;
      }
    }
  } catch (err) {
    // Non-fatal — caller will just see the key as missing and report that
    // clearly rather than crashing the app over a malformed .env file.
    console.error('[env] Failed to read .env file:', err.message);
  }
}

function get(key) {
  loadEnvFile();
  return process.env[key];
}

module.exports = { get };
