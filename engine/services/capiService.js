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
 * WHY ONE SHARED CLIENT ID (same model as EDDiscovery's CAPI submodule)?
 *   The Client ID identifies the APPLICATION to Frontier, not the person
 *   running it. Every install of Elite Explorer — everyone who downloads
 *   the official release — uses the same one Client ID, registered once by
 *   the maintainer. End users never see a Client ID field anywhere in the
 *   UI and never register anything themselves; they just click "Log in
 *   with Frontier" and it works, exactly like EDDiscovery's official builds.
 *
 * MAINTAINER ONE-TIME SETUP (not needed by end users, only whoever builds
 * official releases):
 *   1. Go to https://user.frontierstore.net/developer/docs
 *   2. Register an application with redirect URI: eliteexplorer://capi/callback
 *   3. Copy the Client ID they give you into a local `.env` file (see
 *      .env.example) as FRONTIER_CLIENT_ID=... — or set it as a real
 *      environment variable when building in CI. Never commit it (see
 *      .gitignore) — same reasoning as EDDiscovery keeping its client ID
 *      out of the CAPI repo's version control entirely.
 *   (No client secret needed — this uses the PKCE public client flow)
 *
 * If FRONTIER_CLIENT_ID isn't set, `hasClientId` below is false and cAPI
 * features are simply unavailable in that build — there is deliberately no
 * fallback UI asking the user to supply their own.
 * ─────────────────────────────────────────────────────────────────────────────
 */

const fs     = require('fs');
const path   = require('path');
const https  = require('https');
const crypto = require('crypto');
const { app, shell } = require('electron');
const logger   = require('../core/logger');
const eventBus = require('../core/eventBus');
const env      = require('../core/env');

// IMPORTANT: this must be the SAME file main.js reads/writes (app.getPath
// ('userData')/config.json), not the bundled repo config.json under
// __dirname. The access/refresh tokens saved after a successful login go
// through this same file via saveTokens() below. If this file used
// __dirname/../../config.json instead (as it originally did), a token saved
// here would never be visible to the rest of the app, and vice versa. This
// also matters in packaged builds: __dirname points inside app.asar, which
// is read-only, so writeConfig() would throw when saving tokens.
// writeConfig() would throw when saving tokens.
// ── Frontier Client ID ─────────────────────────────────────────────────────────
// This belongs to the APPLICATION (registered once by the developer at
// https://user.frontierstore.net/developer/docs), not to each person who runs
// it. Every install of Elite Explorer uses this same Client ID — end users
// never see or enter one, they just click "Log in with Frontier".
//
// IMPORTANT: this is intentionally NOT a literal string in source. A PKCE
// public client's ID still has to ship inside the built app (there's no way
// around that — the app needs it to talk to Frontier), but there's no reason
// for it to also sit in plain text in this file's git history, where anyone
// browsing the repo can lift it and build a lookalike app that shows *our*
// registered app identity on Frontier's login screen. Keeping it out of
// source control at least stops that casual copy-paste path.
//
// Loaded from (in order): a real FRONTIER_CLIENT_ID environment variable
// (e.g. set by CI when building releases), or a .env file in the project
// root (gitignored — see .env.example for the template). See engine/core/env.js.
const CLIENT_ID_RAW = env.get('FRONTIER_CLIENT_ID') || '';

// Copy-pasting from Frontier's developer portal can easily drag along a
// stray tab, space, or newline character that isn't visible on screen but
// makes the value not match what Frontier has on file — producing exactly
// an HTTP 401 "Incorrect client credentials" response. Trim it here so
// that class of mistake can't cause a silent mismatch.
const CLIENT_ID = CLIENT_ID_RAW.trim();

// ── Diagnostic: confirm what's actually loaded, without printing the whole
// ID to logs. Catches the two most common setup mistakes: forgetting to
// replace the placeholder in .env, and hidden whitespace/quote characters
// that survived copy-paste. If you're getting "Invalid client ID" from
// Frontier, check this log line first.
if (!CLIENT_ID) {
  logger.warn('CAPI', 'FRONTIER_CLIENT_ID is empty or not set — see .env.example');
} else if (CLIENT_ID === 'your-frontier-client-id-here') {
  logger.error('CAPI', 'FRONTIER_CLIENT_ID is still the placeholder value from .env.example — edit .env and put your real Client ID in it.');
} else if (CLIENT_ID_RAW !== CLIENT_ID) {
  logger.warn('CAPI', 'FRONTIER_CLIENT_ID had leading/trailing whitespace that was trimmed', {
    rawLength: CLIENT_ID_RAW.length, trimmedLength: CLIENT_ID.length,
  });
} else {
  logger.info('CAPI', 'FRONTIER_CLIENT_ID loaded', {
    length: CLIENT_ID.length,
    preview: CLIENT_ID.slice(0, 4) + '...' + CLIENT_ID.slice(-4),
  });
}

const userDataDir = (app && app.getPath) ? app.getPath('userData') : path.join(__dirname, '../..');
const CONFIG_PATH  = path.join(userDataDir, 'config.json');

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

  // Verifier: base64url-encode the bytes, strip ALL padding. RFC 7636 restricts
  // code_verifier to [A-Za-z0-9-._~] — "=" is not a legal character in it.
  // (Confirmed against EDDiscovery's CAPI.cs, the reference implementation this
  // login flow is modelled on: its base64UrlEncode() strips "=" unconditionally
  // and is used for both the verifier and the challenge.)
  const codeVerifier = verifierBytes.toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=/g, '');

  // Challenge: SHA-256 of the ASCII bytes of the code_verifier STRING itself —
  // NOT of the original random bytes it was derived from. This is what RFC 7636
  // actually specifies (code_challenge = BASE64URL(SHA256(ASCII(code_verifier)))),
  // and it's what EDDiscovery does: it hashes Encoding.ASCII.GetBytes(verifier)
  // where `verifier` is already the encoded string, not the raw bytes. Hashing
  // verifierBytes instead (as this code previously did) produces a challenge
  // that Frontier can never match against the verifier sent at token-exchange
  // time, since it recomputes the hash from the string you sent, not from bytes
  // it never saw.
  const challengeDigest = crypto.createHash('sha256').update(codeVerifier, 'ascii').digest();
  const codeChallenge = challengeDigest.toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=/g, '');

  return { codeVerifier, codeChallenge };
}

// ── HTTPS helpers ─────────────────────────────────────────────────────────────
// NOTE ON REDIRECTS: Node's `https` module does NOT follow redirects
// automatically. EDDiscovery's C# implementation uses HttpWebRequest with
// AllowAutoRedirect = true and explicitly guards for HttpStatusCode.Found on
// its GET endpoints — meaning Frontier's cAPI genuinely does 3xx redirect in
// practice. Without following it ourselves here, those responses show up as
// an empty body with a 3xx status and get reported as a confusing generic
// error instead of being handled. httpsGet() below follows a bounded number
// of redirects, same as a browser would.
const MAX_REDIRECTS = 5;

// EDDiscovery's token-exchange call explicitly sets `KeepAlive = false`
// (see URLCallBack in CAPI.cs) — a fix for connection-reuse issues talking to
// Frontier's auth server specifically. We mirror that here with
// `Connection: close` on every POST to /token.
function httpsPost(hostname, urlPath, data) {
  return new Promise((resolve, reject) => {
    const body = new URLSearchParams(data).toString();
    const req = https.request({
      hostname, port: 443, path: urlPath, method: 'POST',
      headers: {
        'Content-Type':   'application/x-www-form-urlencoded',
        'Content-Length': Buffer.byteLength(body),
        'User-Agent':     'EliteExplorer/1.0',
        'Connection':     'close',
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

function httpsGet(hostname, urlPath, accessToken, _redirectCount) {
  const redirectCount = _redirectCount || 0;

  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname, port: 443, path: urlPath, method: 'GET',
      headers: {
        'Authorization': 'Bearer ' + accessToken,
        'User-Agent':    'EliteExplorer/1.0',
      },
    }, (res) => {
      // Follow redirects ourselves (see MAX_REDIRECTS comment above).
      if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location) {
        res.resume(); // discard the (usually empty) redirect body
        if (redirectCount >= MAX_REDIRECTS) {
          resolve({ status: res.statusCode, body: {}, _raw: 'Too many redirects' });
          return;
        }
        const next = new URL(res.headers.location, `https://${hostname}${urlPath}`);
        httpsGet(next.hostname, next.pathname + next.search, accessToken, redirectCount + 1)
          .then(resolve, reject);
        return;
      }

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
// Includes whatever body Frontier sent back — it's often a small JSON object
// with real detail (e.g. {"error":"invalid_token"}), and swallowing it was
// making every failure look identical and impossible to diagnose from logs.
function capiStatusError(status, body) {
  const detail = body && Object.keys(body).length ? ' — ' + JSON.stringify(body) : '';
  if (status === 401 || status === 422) {
    clearTokens();
    return 'Token expired or invalid — please log in again.' + detail;
  }
  if (status === 418) return 'Frontier cAPI is in maintenance mode. Try again later.' + detail;
  return 'cAPI returned HTTP ' + status + detail;
}

// 204 = Frontier has nothing to return right now. This is NOT a failure — it's
// the documented, very common state for /market and /shipyard for several
// seconds right after docking, while Frontier's cache catches up (this is why
// EDDiscovery retries market/shipyard up to 3 times, 10s apart, instead of
// treating a single empty response as a hard error). We surface it as its own
// outcome so callers (capiProvider) can retry instead of logging a false
// failure.
const NOT_READY = 'CAPI_NOT_READY';

// ── Token refresh ─────────────────────────────────────────────────────────────
async function refreshToken() {
  const cfg = readConfig();
  if (!cfg.capiRefreshToken) {
    throw new Error('No refresh token — please log in again.');
  }
  if (!hasValidRefreshToken()) {
    clearTokens();
    throw new Error('Refresh token expired (25-day limit) — please log in again.');
  }

  logger.debug('CAPI', 'Refreshing access token...');
  const refreshParams = {
    grant_type:    'refresh_token',
    client_id:     CLIENT_ID,
    refresh_token: cfg.capiRefreshToken,
  };
  const { status, body } = await httpsPost('auth.frontierstore.net', '/token', refreshParams);

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
    if (!CLIENT_ID) {
      resolve({ success: false, error: 'App is not configured with a Frontier Client ID. This is a bug in the app itself, not something you can fix from Options — please report it.' });
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
      client_id:             CLIENT_ID,
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

    const codeParams = {
      grant_type:    'authorization_code',
      client_id:     CLIENT_ID,
      code,
      redirect_uri:  REDIRECT_URI,
      code_verifier: verifier,
    };
    const { status, body } = await httpsPost('auth.frontierstore.net', '/token', codeParams);

    if (body.access_token) {
      const expiresAt = Date.now() + (body.expires_in || 7200) * 1000;
      saveTokens(body.access_token, body.refresh_token, expiresAt);
      logger.info('CAPI', 'Login successful — access token saved', { expires: new Date(expiresAt).toISOString() });

      // Bring the app back to the foreground — the browser handed off to us
      // via the custom protocol, but on most OS/browser combos the browser
      // tab itself stays open (we don't control that page; it's hosted by
      // Frontier). Surfacing our own window is the part we CAN do to make
      // the "come back to the app" handoff feel immediate.
      if (mainWindow && !mainWindow.isDestroyed()) {
        if (mainWindow.isMinimized()) mainWindow.restore();
        mainWindow.show();
        mainWindow.focus();
      }

      // Let capiProvider (or anything else listening) know login just
      // succeeded, so it can sync profile/market/shipyard/fleetcarrier/
      // communitygoals immediately instead of waiting on its own timer.
      eventBus.emit('capi.login.success');

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
    hasClientId:       !!CLIENT_ID,
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
    return { success: false, error: capiStatusError(status, body) };
  } catch (err) {
    return { success: false, error: err.message };
  }
}

// ── Fetch market data ─────────────────────────────────────────────────────────
// 204 = docked but Frontier's market cache isn't warm yet — not an error.
// notReady:true tells capiProvider it's worth a short retry, same as
// EDDiscovery's 3-tries/10s-apart loop for this exact endpoint.
async function getMarket() {
  try {
    const token = await getToken();
    const { status, body } = await httpsGet('companion.orerve.net', '/market', token);
    if (status === 200) return { success: true, data: body };
    if (status === 204) return { success: false, notReady: true, error: 'Market data not ready yet.' };
    return { success: false, error: capiStatusError(status, body) };
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
    if (status === 204) return { success: false, notReady: true, error: 'Shipyard data not ready yet.' };
    return { success: false, error: capiStatusError(status, body) };
  } catch (err) {
    return { success: false, error: err.message };
  }
}

// ── Fetch fleet carrier data ───────────────────────────────────────────────────
// 200 = has a carrier, 204 = doesn't own one (not an error).
async function getFleetCarrier() {
  try {
    const token = await getToken();
    const { status, body } = await httpsGet('companion.orerve.net', '/fleetcarrier', token);
    if (status === 200) return { success: true, data: body };
    if (status === 204) return { success: true, data: null }; // no carrier owned
    return { success: false, error: capiStatusError(status, body) };
  } catch (err) {
    return { success: false, error: err.message };
  }
}

// ── Fetch active Community Goals ──────────────────────────────────────────────
async function getCommunityGoals() {
  try {
    const token = await getToken();
    const { status, body } = await httpsGet('companion.orerve.net', '/communitygoals', token);
    if (status === 200) return { success: true, data: body };
    return { success: false, error: capiStatusError(status, body) };
  } catch (err) {
    return { success: false, error: err.message };
  }
}

// ── Startup ───────────────────────────────────────────────────────────────────
// NOTE: protocol client registration (app.setAsDefaultProtocolClient) is done
// ONCE, in main.js, before this function runs — and it's dev-mode aware
// (passes process.execPath + the app path as launch args when running
// unpackaged via `npm start`/`electron .`). Do NOT re-register it here: an
// earlier version of this file called app.setAsDefaultProtocolClient(PROTOCOL)
// with no extra args, which ran AFTER main.js's registration and silently
// overwrote the correct Windows registry entry with a bare one — the entry
// then pointed at plain "electron.exe" with no project path, so a callback
// URI launched electron.exe with the URL as its only argument. Electron's
// default_app bootstrap then tried to treat that URL as the app path to load,
// producing "Unable to find Electron app at ...\callback?code=...".
function start() {
  const cfg = readConfig();

  // ── Startup diagnostics ──────────────────────────────────────────────────
  if (!CLIENT_ID) {
    logger.error('CAPI', 'No Frontier Client ID found — cAPI features will be unavailable. Copy .env.example to .env and fill in FRONTIER_CLIENT_ID (dev), or set the FRONTIER_CLIENT_ID environment variable when building a release.');
  } else {
    logger.info('CAPI', 'Frontier Client ID is configured');
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
  getFleetCarrier, getCommunityGoals,
};