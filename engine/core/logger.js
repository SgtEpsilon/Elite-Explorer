'use strict';

/**
 * logger.js — in-memory debug log with optional file export.
 *
 * Usage (main process):
 *   const logger = require('./engine/core/logger');
 *   logger.info('engine', 'Engine started');
 *   logger.warn('journal', 'Journal file not found', { path: '/...' });
 *   logger.error('capi', 'OAuth failed', err);
 *
 * From the renderer (via preload IPC):
 *   const lines = await window.electronAPI.getDebugLog();
 *   await window.electronAPI.saveDebugLog();   // opens save dialog
 */

const MAX_ENTRIES = 2000;   // cap in-memory buffer to avoid unbounded growth

const _entries = [];        // { ts, level, tag, message, detail }

function _add(level, tag, message, detail) {
  const entry = {
    ts:      new Date().toISOString(),
    level,
    tag:     String(tag).toUpperCase(),
    message: String(message),
    detail:  detail != null ? _stringify(detail) : undefined,
  };
  _entries.push(entry);
  if (_entries.length > MAX_ENTRIES) _entries.shift();

  // Also mirror to the Node console so developers see it during dev-mode runs
  const line = `[${entry.ts}] [${level}] [${entry.tag}] ${entry.message}${entry.detail ? ' — ' + entry.detail : ''}`;
  if      (level === 'ERROR') console.error(line);
  else if (level === 'WARN')  console.warn(line);
  else                        console.log(line);
}

function _stringify(val) {
  if (val instanceof Error) return `${val.name}: ${val.message}${val.stack ? '\n' + val.stack : ''}`;
  if (typeof val === 'object') try { return JSON.stringify(val); } catch { return String(val); }
  return String(val);
}

// ── Public API ────────────────────────────────────────────────────────────────
const logger = {
  debug: (tag, msg, detail) => _add('DEBUG', tag, msg, detail),
  info:  (tag, msg, detail) => _add('INFO',  tag, msg, detail),
  warn:  (tag, msg, detail) => _add('WARN',  tag, msg, detail),
  error: (tag, msg, detail) => _add('ERROR', tag, msg, detail),

  /** Returns all log entries as an array of plain objects. */
  getEntries() { return [..._entries]; },

  /**
   * Formats all entries as a human-readable string suitable for a bug report.
   * @param {object} [meta]  Extra metadata appended to the header (app version, etc.)
   */
  format(meta = {}) {
    const header = [
      '═══════════════════════════════════════════════════',
      '  Elite Explorer — Debug Log',
      `  Generated : ${new Date().toISOString()}`,
      ...Object.entries(meta).map(([k, v]) => `  ${k.padEnd(10)}: ${v}`),
      '═══════════════════════════════════════════════════',
      '',
    ].join('\n');

    const body = _entries.map(e => {
      const base = `${e.ts}  ${e.level.padEnd(5)}  [${e.tag}]  ${e.message}`;
      return e.detail ? base + '\n' + e.detail.split('\n').map(l => '             ' + l).join('\n') : base;
    }).join('\n');

    return header + (body || '(no log entries)');
  },

  /** Clears the in-memory buffer (useful in tests). */
  clear() { _entries.length = 0; },
};

module.exports = logger;
