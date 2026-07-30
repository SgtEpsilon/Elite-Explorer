/**
 * engine/core/geo.js
 *
 * Small original helper for the "flat local tangent plane" approximation
 * used to place Guardian site POIs and the live commander position on a
 * 2D map. At the scale of a single site (tens to low hundreds of meters)
 * this is accurate enough that a proper great-circle/geodesic calculation
 * would be indistinguishable on screen — no third-party geo library or
 * reference implementation was needed or consulted.
 *
 * All angles in degrees in/out; distances in meters.
 */

const DEG2RAD = Math.PI / 180;

/**
 * Bearing (0-360, 0 = north) and straight-line distance (meters) from an
 * origin lat/long to a target lat/long, given the body's radius in meters.
 * Uses a local equirectangular projection centered on the origin — valid
 * for the sub-kilometer scale a Guardian site occupies.
 */
function bearingDistance(originLat, originLon, targetLat, targetLon, planetRadiusM) {
  if ([originLat, originLon, targetLat, targetLon, planetRadiusM].some((v) => v == null || Number.isNaN(v))) {
    return null;
  }
  const avgLatRad = ((originLat + targetLat) / 2) * DEG2RAD;
  const dLatM = (targetLat - originLat) * DEG2RAD * planetRadiusM;
  const dLonM = (targetLon - originLon) * DEG2RAD * planetRadiusM * Math.cos(avgLatRad);

  const distanceM = Math.sqrt(dLatM * dLatM + dLonM * dLonM);
  // atan2(east, north) so 0 = north, 90 = east, matching in-game compass bearing.
  let bearingDeg = Math.atan2(dLonM, dLatM) / DEG2RAD;
  if (bearingDeg < 0) bearingDeg += 360;

  return { bearingDeg, distanceM };
}

/** Local xy (meters, x=east, y=north) offset from bearing+distance — the inverse of the above, used by the renderer. */
function bearingDistanceToXY(bearingDeg, distanceM) {
  const rad = bearingDeg * DEG2RAD;
  return { x: Math.sin(rad) * distanceM, y: Math.cos(rad) * distanceM };
}

module.exports = { bearingDistance, bearingDistanceToXY };
