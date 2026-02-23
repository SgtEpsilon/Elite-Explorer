/**
 * engine/services/capiService.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Frontier Companion API (cAPI) integration.
 *
 * The cAPI is Frontier's official API for reading live commander data:
 * credits, ship loadout, ranks, current location, market prices, etc.
 * It requires OAuth2 + PKCE authentication via Frontier's auth servers.
 *
 * OFFICIAL DOCS: https://hosting.zaonce.net/docs/oauth2/instructions.html
 *
 * HOW THE LOGIN FLOW WORKS:
 *   1. We open Frontier's /auth page in the user's real browser.
 *   2. After they log in, Frontier redirects to our custom URI scheme:
 *        eliteexplorer://capi/callback?code=...&state=...
 *   3. Electron intercepts that URI via app.setAsDefaultProtocolClient()
 *      and passes it to us via the 'open-url' (macOS/Linux) or
 *      second-instance (Windows) app event, both wired in main.js.
 *   4. We extract the auth code, POST it to /token with our code_verifier
 *      (PKCE), and get back access + refresh tokens.
 *   5. Tokens are saved to config.json and auto-refreshed before expiry.
 *
 * WHY A CUSTOM URI SCHEME (not http://localhost)?
 *   Frontier's auth server requires https:// redirect URIs. A local HTTP
 *   server on localhost uses http://, which Frontier rejects with a 404.
 *   Electron's custom protocol handler lets us use eliteexplorer:// which
 *   Frontier accepts as a registered native application URI scheme.
 *
 * ONE-TIME SETUP (register at Frontier developer portal):
 *   1. Go to https://user.frontierstore.net/developer/docs
 *   2. Register a new application
 *   3. Set the redirect URI to exactly: eliteexplorer://capi/callback
 *   4. Copy the Client ID they give you
 *   5. Enter it in Options > Frontier cAPI > Client ID field
 *   (No client secret needed — this uses the PKCE public client flow)
 * ─────────────────────────────────────────────────────────────────────────────
 */

const fs     = require('fs');
const path   = require('path');
const https  = require('https');
const crypto = require('crypto');
const { app, shell } = require('electron');
const logger = require('../core/logger');

const CONFIG_PATH = path.join(__dirname, '../../config.json');

// ── Frontier endpoints (from official docs) ───────────────────────────────────
const AUTH_BASE = 'https://auth.frontierstore.net';
// CAPI_BASE kept for reference — used directly in httpsGet calls below
// const CAPI_BASE = 'https://companion.orerve.net';

// Custom URI scheme registered with Electron and the Frontier developer portal.
// Frontier redirects here after the user logs in.
const PROTOCOL     = 'eliteexplorer';
const REDIRECT_URI = PROTOCOL + '://capi/callback';

// Token lifetime = 7200s (2h). Refresh 60s early.
// Refresh tokens expire after 25 days — after that the user must re-login.
const REFRESH_BUFFER_MS  = 60 * 1000;
const REFRESH_TOKEN_DAYS = 25;

let mainWindow = null;
function setMainWindow(win) { mainWindow = win; }

function send(channel, data) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send(channel, data);
  }
}

// ── Config helpers ────────────────────────────────────────────────────────────
function readConfig()     { try { return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8')); } catch { return {}; } }
function writeConfig(obj) { fs.writeFileSync(CONFIG_PATH, JSON.stringify(obj, null, 2)); }

function saveTokens(accessToken, refreshToken, expiresAt) {
  const cfg = readConfig();
  cfg.capiAccessToken   = accessToken;
  cfg.capiRefreshToken  = refreshToken;
  cfg.capiTokenExpiry   = expiresAt;
  cfg.capiRefreshExpiry = Date.now() + REFRESH_TOKEN_DAYS * 24 * 60 * 60 * 1000;
  writeConfig(cfg);
}

function clearTokens() {
  const cfg = readConfig();
  delete cfg.capiAccessToken;
  delete cfg.capiRefreshToken;
  delete cfg.capiTokenExpiry;
  delete cfg.capiRefreshExpiry;
  writeConfig(cfg);
}

// ── Token state ───────────────────────────────────────────────────────────────
function hasValidToken() {
  const cfg = readConfig();
  return !!(
    cfg.capiAccessToken &&
    cfg.capiTokenExpiry &&
    Date.now() < cfg.capiTokenExpiry - REFRESH_BUFFER_MS
  );
}

function hasValidRefreshToken() {
  const cfg = readConfig();
  return !!(cfg.capiRefreshToken &&
    (!cfg.capiRefreshExpiry || Date.now() < cfg.capiRefreshExpiry));
}

function getAccessToken() { return readConfig().capiAccessToken || null; }

// ── PKCE ─────────────────────────────────────────────────────────────────────
// From the official Frontier PKCE notes:
//   "you will need to make sure your sha256 hash of the verifier is a binary
//    data digest, and not hex encoded — then encoded using Base64URL Encoding."
//
//   code_verifier:  random bytes → Base64URL (keep trailing =)
//   code_challenge: SHA-256 of the raw BYTES (not the base64 string!) →
//                   Base64URL with trailing = STRIPPED.
//
// Stripping = from the verifier or keeping = on the challenge both cause errors.
function generatePKCE() {
  const verifierBytes = crypto.randomBytes(32);

  // Verifier: base64url-encode the bytes, keep trailing =
  const codeVerifier = verifierBytes.toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_');
  // (trailing = intentionally kept)

  // Challenge: SHA-256 of the RAW BYTES, then base64url WITHOUT trailing =
  const challengeDigest = crypto.createHash('sha256').update(verifierBytes).digest();
  const codeChallenge = challengeDigest.toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=/g, '');  // must strip = from challenge

  return { codeVerifier, codeChallenge };
}

// ── HTTPS helpers ─────────────────────────────────────────────────────────────
function httpsPost(hostname, urlPath, data) {
  return new Promise((resolve, reject) => {
    const body = new URLSearchParams(data).toString();
    const req = https.request({
      hostname, port: 443, path: urlPath, method: 'POST',
      headers: {
        'Content-Type':   'application/x-www-form-urlencoded',
        'Content-Length': Buffer.byteLength(body),
        'User-Agent':     'EliteExplorer/1.0',
      },
    }, (res) => {
      let raw = '';
      res.on('data', c => raw += c);
      res.on('end', () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(raw) }); }
        catch { resolve({ status: res.statusCode, body: {}, _raw: raw }); }
      });
    });
    req.on('error', reject);
    req.setTimeout(10000, () => { req.destroy(); reject(new Error('Request timed out')); });
    req.write(body);
    req.end();
  });
}

function httpsGet(hostname, urlPath, accessToken) {
  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname, port: 443, path: urlPath, method: 'GET',
      headers: {
        'Authorization': 'Bearer ' + accessToken,
        'User-Agent':    'EliteExplorer/1.0',
      },
    }, (res) => {
      let raw = '';
      res.on('data', c => raw += c);
      res.on('end', () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(raw) }); }
        catch { resolve({ status: res.statusCode, body: {}, _raw: raw }); }
      });
    });
    req.on('error', reject);
    req.setTimeout(10000, () => { req.destroy(); reject(new Error('Request timed out')); });
    req.end();
  });
}

// ── cAPI HTTP status → error string ──────────────────────────────────────────
// 401/422 → expired/invalid token (clear and re-login)
// 418     → Frontier maintenance ("I'm a teapot") — don't clear tokens
function capiStatusError(status) {
  if (status === 401 || status === 422) {
    clearTokens();
    return 'Token expired or invalid — please log in again.';
  }
  if (status === 418) return 'Frontier cAPI is in maintenance mode. Try again later.';
  return 'cAPI returned HTTP ' + status;
}

// ── Token refresh ─────────────────────────────────────────────────────────────
async function refreshToken() {
  const cfg = readConfig();
  if (!cfg.capiRefreshToken || !cfg.capiClientId) {
    throw new Error('No refresh token or Client ID — please log in again.');
  }
  if (!hasValidRefreshToken()) {
    clearTokens();
    throw new Error('Refresh token expired (25-day limit) — please log in again.');
  }

  logger.debug('CAPI', 'Refreshing access token...');
  const { status, body } = await httpsPost('auth.frontierstore.net', '/token', {
    grant_type:    'refresh_token',
    client_id:     cfg.capiClientId,
    refresh_token: cfg.capiRefreshToken,
  });

  if (body.access_token) {
    const expiresAt = Date.now() + (body.expires_in || 7200) * 1000;
    saveTokens(body.access_token, body.refresh_token || cfg.capiRefreshToken, expiresAt);
    logger.info('CAPI', 'Access token refreshed', { expires: new Date(expiresAt).toISOString() });
    return body.access_token;
  }
  throw new Error('Token refresh failed (HTTP ' + status + '): ' + JSON.stringify(body));
}

// ── Get a valid access token, refreshing if needed ────────────────────────────
async function getToken() {
  if (hasValidToken()) return getAccessToken();
  return refreshToken();
}

// ── OAuth2 + PKCE login flow ──────────────────────────────────────────────────
// In-flight login state — stored here so handleCallback() can resolve the promise.
let _loginResolve  = null;
let _loginState    = null;
let _loginVerifier = null;
let _loginTimeout  = null;

function startOAuthLogin() {
  return new Promise((resolve) => {
    const cfg = readConfig();

    if (!cfg.capiClientId) {
      resolve({ success: false, error: 'No Client ID saved. Enter your Frontier Client ID in Options and try again.' });
      return;
    }

    // Cancel any previous in-flight login
    if (_loginResolve) {
      clearTimeout(_loginTimeout);
      _loginResolve({ success: false, error: 'Login cancelled — new attempt started.' });
    }

    const state = crypto.randomBytes(16).toString('hex');
    const { codeVerifier, codeChallenge } = generatePKCE();

    _loginResolve  = resolve;
    _loginState    = state;
    _loginVerifier = codeVerifier;

    // 5-minute timeout
    _loginTimeout = setTimeout(() => {
      if (_loginResolve) {
        _loginResolve({ success: false, error: 'Login timed out after 5 minutes.' });
        _loginResolve = _loginState = _loginVerifier = _loginTimeout = null;
      }
    }, 5 * 60 * 1000);

    // audience=all → accepts Frontier, Steam, Xbox, PSN logins.
    // Change to audience=frontier to restrict to Frontier accounts only.
    const loginUrl = AUTH_BASE + '/auth?' + new URLSearchParams({
      response_type:         'code',
      client_id:             cfg.capiClientId,
      redirect_uri:          REDIRECT_URI,
      scope:                 'auth capi',
      audience:              'all',
      state,
      code_challenge:        codeChallenge,
      code_challenge_method: 'S256',
    }).toString();

    logger.info('CAPI', 'Opening Frontier login in browser', { redirectUri: REDIRECT_URI });
    shell.openExternal(loginUrl);
  });
}

// ── Handle the OAuth2 callback URI ───────────────────────────────────────────
// Called from main.js when Electron receives the eliteexplorer:// URI.
//
// main.js must wire this up in TWO places:
//
//   // macOS / Linux — URI passed directly via open-url event
//   app.on('open-url', (event, url) => {
//     event.preventDefault();
//     capiService.handleCallback(url);
//   });
//
//   // Windows — app launched a second time with URI in argv
//   app.on('second-instance', (event, argv) => {
//     const url = argv.find(a => a.startsWith('eliteexplorer://'));
//     if (url) capiService.handleCallback(url);
//     // Also focus the existing window
//     if (mainWindow) { mainWindow.restore(); mainWindow.focus(); }
//   });
//
// The gotTheLock / requestSingleInstanceLock() pattern in main.js is also
// required on Windows to ensure only one instance runs at a time.
async function handleCallback(callbackUrl) {
  logger.debug('CAPI', 'OAuth callback URI received', { url: callbackUrl });

  if (!_loginResolve) {
    logger.warn('CAPI', 'OAuth callback received but no login was in progress — ignoring');
    return;
  }

  const resolve  = _loginResolve;
  const state    = _loginState;
  const verifier = _loginVerifier;

  // Clear pending state immediately
  clearTimeout(_loginTimeout);
  _loginResolve = _loginState = _loginVerifier = _loginTimeout = null;

  try {
    const url           = new URL(callbackUrl);
    const code          = url.searchParams.get('code');
    const returnedState = url.searchParams.get('state');
    const error         = url.searchParams.get('error');

    if (error) {
      resolve({ success: false, error: 'Frontier error: ' + (url.searchParams.get('error_description') || error) });
      return;
    }
    if (returnedState !== state) {
      resolve({ success: false, error: 'State mismatch — possible CSRF attack. Please try again.' });
      return;
    }
    if (!code) {
      resolve({ success: false, error: 'No auth code in callback from Frontier.' });
      return;
    }

    const cfg = readConfig();
    const { status, body } = await httpsPost('auth.frontierstore.net', '/token', {
      grant_type:    'authorization_code',
      client_id:     cfg.capiClientId,
      code,
      redirect_uri:  REDIRECT_URI,
      code_verifier: verifier,
    });

    if (body.access_token) {
      const expiresAt = Date.now() + (body.expires_in || 7200) * 1000;
      saveTokens(body.access_token, body.refresh_token, expiresAt);
      logger.info('CAPI', 'Login successful — access token saved', { expires: new Date(expiresAt).toISOString() });

      // Push profile to renderer right away
      try {
        const profileResult = await getProfile();
        if (profileResult.success) send('capi-data', { type: 'profile', data: profileResult.data });
      } catch {}

      resolve({ success: true });
    } else {
      resolve({ success: false, error: 'Token exchange failed (HTTP ' + status + '): ' + JSON.stringify(body) });
    }
  } catch (err) {
    resolve({ success: false, error: 'Callback error: ' + err.message });
  }
}

// ── Logout ────────────────────────────────────────────────────────────────────
function logout() {
  clearTokens();
  logger.info('CAPI', 'Logged out — tokens cleared');
  return { success: true };
}

// ── Status ────────────────────────────────────────────────────────────────────
function getStatus() {
  const cfg = readConfig();
  return {
    hasClientId:       !!cfg.capiClientId,
    isLoggedIn:        !!cfg.capiAccessToken,
    tokenValid:        hasValidToken(),
    tokenExpiry:       cfg.capiTokenExpiry   || null,
    refreshExpiry:     cfg.capiRefreshExpiry || null,
    refreshTokenValid: hasValidRefreshToken(),
  };
}

// ── Fetch commander profile ───────────────────────────────────────────────────
async function getProfile() {
  try {
    const token = await getToken();
    const { status, body } = await httpsGet('companion.orerve.net', '/profile', token);
    if (status === 200 && body.commander) {
      const cmdr = body.commander;
      return {
        success: true,
        data: {
          commander: {
            name:    cmdr.name,
            credits: cmdr.credits,
            debt:    cmdr.debt || 0,
            ranks: {
              combat:     cmdr.rank?.combat,
              trade:      cmdr.rank?.trade,
              explore:    cmdr.rank?.explore,
              cqc:        cmdr.rank?.cqc,
              empire:     cmdr.rank?.empire,
              federation: cmdr.rank?.federation,
            },
          },
          lastSystem: body.lastSystem?.name || null,
          ship: body.ship ? {
            name:  body.ship.name,
            model: body.ship.modules?.CargoHatch?.item || null,
            value: body.ship.value?.total || null,
          } : null,
          rawProfile: body,
        },
      };
    }
    return { success: false, error: capiStatusError(status) };
  } catch (err) {
    return { success: false, error: err.message };
  }
}

// ── Fetch market data ─────────────────────────────────────────────────────────
async function getMarket() {
  try {
    const token = await getToken();
    const { status, body } = await httpsGet('companion.orerve.net', '/market', token);
    if (status === 200) return { success: true, data: body };
    return { success: false, error: capiStatusError(status) };
  } catch (err) {
    return { success: false, error: err.message };
  }
}

// ── Fetch shipyard data ───────────────────────────────────────────────────────
async function getShipyard() {
  try {
    const token = await getToken();
    const { status, body } = await httpsGet('companion.orerve.net', '/shipyard', token);
    if (status === 200) return { success: true, data: body };
    return { success: false, error: capiStatusError(status) };
  } catch (err) {
    return { success: false, error: err.message };
  }
}

// ── Startup ───────────────────────────────────────────────────────────────────
function start() {
  if (app.isReady()) {
    app.setAsDefaultProtocolClient(PROTOCOL);
  } else {
    app.whenReady().then(() => app.setAsDefaultProtocolClient(PROTOCOL));
  }

  const cfg = readConfig();

  // ── Startup diagnostics ──────────────────────────────────────────────────
  if (!cfg.capiClientId) {
    logger.warn('CAPI', 'No Frontier Client ID configured — cAPI features will be unavailable. Set one in Options > Frontier cAPI.');
  } else {
    logger.info('CAPI', 'Frontier Client ID is set');
  }

  if (!cfg.capiAccessToken) {
    logger.info('CAPI', 'Not logged in to Frontier cAPI — skipping auto-refresh');
    return;
  }

  const tokenValid   = hasValidToken();
  const refreshValid = hasValidRefreshToken();
  const expiry       = cfg.capiTokenExpiry ? new Date(cfg.capiTokenExpiry).toISOString() : 'unknown';
  const refreshExp   = cfg.capiRefreshExpiry ? new Date(cfg.capiRefreshExpiry).toISOString() : 'unknown';

  if (tokenValid) {
    logger.info('CAPI', 'Logged in — access token valid', { expires: expiry });
  } else if (refreshValid) {
    logger.warn('CAPI', 'Access token expired but refresh token is valid — will auto-refresh', { accessExpiry: expiry, refreshExpiry: refreshExp });
  } else {
    logger.error('CAPI', 'Both access and refresh tokens are expired — user must log in again', { accessExpiry: expiry, refreshExpiry: refreshExp });
  }

  setInterval(async () => {
    const c = readConfig();
    if (!c.capiAccessToken) return;
    if ((c.capiTokenExpiry || 0) - Date.now() < REFRESH_BUFFER_MS) {
      logger.debug('CAPI', 'Access token expiring soon — auto-refreshing');
      try { await refreshToken(); }
      catch (err) { logger.error('CAPI', 'Auto-refresh failed', err); }
    }
  }, 60 * 1000);
}

module.exports = {
  start, setMainWindow,
  startOAuthLogin, handleCallback,
  logout, getStatus,
  getProfile, getMarket, getShipyard,
};
