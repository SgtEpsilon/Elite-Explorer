'use strict';

/**
 * networkBus.js
 * A simple in-process event bus that the network server uses to forward
 * Electron IPC push events (live-data, profile-data, etc.) to connected
 * SSE clients.  The network server patches mainWindow.webContents.send so
 * every call also goes through here.
 */

const { EventEmitter } = require('events');

const bus = new EventEmitter();
bus.setMaxListeners(100); // many SSE clients can subscribe

module.exports = bus;
