/**
 * engine/services/spanshClient.js
 *
 * Fetches a full system dump (bodies + stations/settlements) from Spansh,
 * keyed by system id64 (the same "system address" Elite's journal and EDSM
 * both use). Spansh's galaxy data is rebuilt from EDDN on a rolling basis,
 * so it tends to drop stations that no longer exist / have been renamed
 * faster than EDSM's crowd-submitted records do — it's used in edsmClient.js
 * as a second, cross-checked source for the "System Bodies" panel so a
 * single stale EDSM entry doesn't get shown as fact.
 *
 * Spansh doesn't publish a formal API spec — this hits the same endpoint
 * the spansh.co.uk system page itself calls. If Spansh changes their
 * response shape this will start failing quietly (lookupSystem() in
 * edsmClient.js treats it as "unavailable" and falls back to EDSM alone),
 * so if cross-referencing stops doing anything useful, check this file
 * first against a live https://www.spansh.co.uk/api/system/<id64> response.
 */

const BASE_URL = 'https://www.spansh.co.uk';

async function fetchSpanshSystem(id64) {
  if (!id64) return null;
  const res = await fetch(`${BASE_URL}/api/system/${id64}`, { signal: AbortSignal.timeout(10000) });
  if (!res.ok) throw new Error('HTTP ' + res.status);
  return await res.json();
}

module.exports = { fetchSpanshSystem };
