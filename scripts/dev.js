// Dev launcher: runs `electron .` and restarts it automatically whenever a
// source file changes, so `npm run dev` behaves like a live-reload dev server.
//
// Uses chokidar (already a runtime dependency) to watch the app's source —
// main.js, preload.js, index.js, config.json, ui/**, engine/** — while
// ignoring node_modules, dist output, .git, and other noise.
const path      = require('path');
const chokidar  = require('chokidar');
const { spawn } = require('child_process');

const ROOT = path.join(__dirname, '..');

// require('electron') resolves to the path of the electron executable for
// the current platform (not the API) when run outside of Electron itself.
// This avoids spawning through npx/npx.cmd, which throws "spawn EINVAL" on
// some Windows + Node.js version combinations.
const electronPath = require('electron');

const WATCH_PATHS = [
  'main.js',
  'preload.js',
  'index.js',
  'config.json',
  'ui',
  'engine',
].map(p => path.join(ROOT, p));

const IGNORED = [
  /node_modules/,
  /[\\/]dist[\\/]/,
  /[\\/]\.git[\\/]/,
  /[\\/]build[\\/]/,
];

let child = null;
let restarting = false;
let restartQueued = false;

function startElectron() {
  console.log('[dev] Starting Electron\u2026');
  child = spawn(electronPath, ['.'], { cwd: ROOT, stdio: 'inherit', env: process.env, windowsHide: false });

  child.on('error', (err) => {
    console.error('[dev] Failed to launch Electron:', err.message);
  });

  child.on('exit', (code, signal) => {
    child = null;
    // If the app was closed by the user (not by us restarting it), stop watching.
    if (!restarting && !restartQueued) {
      console.log(`[dev] Electron exited (code ${code}${signal ? ', signal ' + signal : ''}). Watching for changes — Ctrl+C to quit.`);
    }
    restarting = false;
    if (restartQueued) {
      restartQueued = false;
      startElectron();
    }
  });
}

function restartElectron(changedPath) {
  const rel = path.relative(ROOT, changedPath);
  console.log(`[dev] Change detected: ${rel} \u2014 restarting\u2026`);

  if (!child) {
    startElectron();
    return;
  }

  if (restarting) {
    // A restart is already in progress; make sure we restart again once
    // the current one finishes, in case more changes came in meanwhile.
    restartQueued = true;
    return;
  }

  restarting = true;
  const toKill = child;
  const forceKillTimer = setTimeout(() => {
    try { toKill.kill('SIGKILL'); } catch (e) {}
  }, 5000);

  toKill.once('exit', () => {
    clearTimeout(forceKillTimer);
    startElectron();
  });

  try {
    toKill.kill(process.platform === 'win32' ? undefined : 'SIGTERM');
  } catch (e) {
    clearTimeout(forceKillTimer);
    startElectron();
  }
}

// Debounce rapid-fire changes (e.g. editors that write multiple times per save)
let debounceTimer = null;
function onChange(changedPath) {
  clearTimeout(debounceTimer);
  debounceTimer = setTimeout(() => restartElectron(changedPath), 150);
}

const watcher = chokidar.watch(WATCH_PATHS, {
  ignored: IGNORED,
  ignoreInitial: true,
  persistent: true,
});

watcher
  .on('change', onChange)
  .on('add', onChange)
  .on('unlink', onChange);

process.on('SIGINT', () => {
  watcher.close();
  if (child) { try { child.kill(); } catch (e) {} }
  process.exit(0);
});

startElectron();
console.log('[dev] Watching main.js, preload.js, index.js, config.json, ui/**, engine/** for changes\u2026');
