/**
 * engine/providers/capiProvider.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Orchestrates Frontier cAPI queries (via engine/services/capiService.js) and
 * pushes the results to the renderer as cached, replayable channels — the same
 * pattern journalProvider/historyProvider use for journal-derived data.
 *
 * WHY A SEPARATE PROVIDER (not just calling capiService straight from main.js)?
 *   - Keeps a cache so every page (Live / Ship / Profile) gets the latest data
 *     immediately on load via replayToPage(), without re-querying Frontier.
 *   - Centralises the "don't hammer the CAPI" logic in one place. Frontier's
 *     own docs ask integrators not to exceed ~1 query/minute in general use,
 *     and never more than 2/sec. refreshAll() enforces a cooldown and fetches
 *     endpoints in sequence rather than in parallel.
 *   - Fetching /market and /shipyard only makes sense when docked — profile is
 *     queried first so we can check `commander.docked` before firing them off.
 *
 * ENDPOINTS COVERED: /profile, /market, /shipyard (includes outfitting stock),
 * /fleetcarrier, /communitygoals.
 *
 * ENDPOINTS DELIBERATELY NOT WIRED UP:
 *   - /journal — duplicates data the app already gets faster and more
 *     completely from local journal files.
 *   - /visitedstars — returns a zip of a binary .dat cache file with no
 *     documented internal format; very low value for very high complexity.
 * ─────────────────────────────────────────────────────────────────────────────
 */

const logger      = require('../core/logger');
const capiService = require('../services/capiService');

// Minimum time between refreshAll() runs, regardless of trigger source.
const MIN_REFRESH_INTERVAL_MS = 60 * 1000;
// Auto-refresh cadence while logged in (station data goes stale fast, but we
// still want to stay well under Frontier's rate-limit guidance).
const AUTO_REFRESH_INTERVAL_MS = 5 * 60 * 1000;

let mainWindow = null;
function setMainWindow(win) { mainWindow = win; }

function send(channel, data) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send(channel, data);
  }
}

// ── Cache — replayed to any page that (re)loads ───────────────────────────────
const cache = {
  profile:        null,
  market:         null,
  shipyard:       null,
  fleetCarrier:   null,
  communityGoals: null,
  lastRefresh:    null,
  lastError:      null,
};

function replayToPage() {
  if (cache.profile)        send('capi-profile-data',         cache.profile);
  if (cache.market)         send('capi-market-data',          cache.market);
  if (cache.shipyard)       send('capi-shipyard-data',        cache.shipyard);
  if (cache.fleetCarrier !== null) send('capi-fleetcarrier-data', cache.fleetCarrier);
  if (cache.communityGoals) send('capi-communitygoals-data',  cache.communityGoals);
  send('capi-refresh-status', {
    lastRefresh: cache.lastRefresh,
    lastError:   cache.lastError,
  });
}

let _lastRefreshAttempt = 0;
let _refreshing         = false;

// ── Fetch everything, in sequence, respecting docked-state and rate limits ───
async function refreshAll(opts) {
  const force = !!(opts && opts.force);

  if (_refreshing) return { success: false, error: 'A refresh is already in progress.' };
  const now = Date.now();
  if (!force && now - _lastRefreshAttempt < MIN_REFRESH_INTERVAL_MS) {
    return { success: false, error: 'Refreshed too recently — please wait a moment.' };
  }
  _lastRefreshAttempt = now;
  _refreshing = true;

  send('capi-refresh-status', { refreshing: true });

  try {
    const status = capiService.getStatus();
    if (!status.hasClientId || !status.isLoggedIn) {
      cache.lastError = 'Not logged in to Frontier cAPI.';
      return { success: false, error: cache.lastError };
    }

    // ── 1. Profile — always fetch first; tells us if/where we're docked ──────
    const profileResult = await capiService.getProfile();
    if (profileResult.success) {
      cache.profile = profileResult.data;
      send('capi-profile-data', cache.profile);
    } else {
      cache.lastError = profileResult.error;
      logger.warn('CAPI', 'Profile refresh failed', { error: profileResult.error });
    }

    const docked = !!(profileResult.success &&
      profileResult.data && profileResult.data.rawProfile &&
      profileResult.data.rawProfile.commander &&
      profileResult.data.rawProfile.commander.docked);

    // ── 2. Market + Shipyard/Outfitting — only meaningful while docked ──────
    if (docked) {
      const marketResult = await capiService.getMarket();
      if (marketResult.success) {
        cache.market = marketResult.data;
        send('capi-market-data', cache.market);
      } else {
        logger.warn('CAPI', 'Market refresh failed', { error: marketResult.error });
      }

      const shipyardResult = await capiService.getShipyard();
      if (shipyardResult.success) {
        cache.shipyard = shipyardResult.data;
        send('capi-shipyard-data', cache.shipyard);
      } else {
        logger.warn('CAPI', 'Shipyard refresh failed', { error: shipyardResult.error });
      }
    }

    // ── 3. Fleet carrier — harmless (204) if the commander doesn't own one ──
    const carrierResult = await capiService.getFleetCarrier();
    if (carrierResult.success) {
      cache.fleetCarrier = carrierResult.data; // null = no carrier owned
      send('capi-fleetcarrier-data', cache.fleetCarrier);
    } else {
      logger.warn('CAPI', 'Fleet carrier refresh failed', { error: carrierResult.error });
    }

    // ── 4. Community Goals ───────────────────────────────────────────────────
    const cgResult = await capiService.getCommunityGoals();
    if (cgResult.success) {
      cache.communityGoals = cgResult.data;
      send('capi-communitygoals-data', cache.communityGoals);
    } else {
      logger.warn('CAPI', 'Community Goals refresh failed', { error: cgResult.error });
    }

    cache.lastRefresh = Date.now();
    if (profileResult.success) cache.lastError = null;
    return { success: true };
  } catch (err) {
    cache.lastError = err.message || String(err);
    return { success: false, error: cache.lastError };
  } finally {
    _refreshing = false;
    send('capi-refresh-status', {
      refreshing:  false,
      lastRefresh: cache.lastRefresh,
      lastError:   cache.lastError,
    });
  }
}

function getCache() { return cache; }

// ── Startup — auto-refresh on a timer while logged in ─────────────────────────
function start() {
  setInterval(() => {
    const status = capiService.getStatus();
    if (status.isLoggedIn) {
      refreshAll().catch((err) => logger.error('CAPI', 'Auto-refresh error', err));
    }
  }, AUTO_REFRESH_INTERVAL_MS);
}

module.exports = {
  start, setMainWindow, replayToPage,
  refreshAll, getCache,
};
