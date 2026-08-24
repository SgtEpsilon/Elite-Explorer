/**
 * scripts/convert-guardian-templates.js
 *
 * One-time (re-runnable) conversion tool. Reads the raw surveyed Guardian
 * site geometry published by the SrvSurvey project (njthomson/SrvSurvey,
 * GPL-3.0 — same license as this project, so direct reuse of the underlying
 * survey DATA is permitted, per project ATTRIBUTION.md) and reshapes it into
 * Elite Explorer's own template + known-site formats:
 *
 *   data/guardianSiteTemplates.json  — per-site-type POI layout, our schema
 *   data/guardianKnownSites.json     — bootstrap list of known site instances
 *
 * This is NOT a copy of SrvSurvey's file format. Differences, deliberately:
 *   - our own POI type taxonomy (extends docs/guardian-sites-schema.md's
 *     enum with `component` and `obelisk-damaged` rather than reusing
 *     SrvSurvey's `component`/`brokeObelisk` strings verbatim)
 *   - obelisk POIs collapsed into named `obeliskGroups` (by shared name
 *     prefix) the way our schema already models them, rather than left as
 *     a flat POI list the renderer has to group itself
 *   - our own local->world bearing convention (see guardianTemplateService.js)
 *   - no backgroundImage/imageOffset/scaleFactor — Elite Explorer renders
 *     sites as vector plots (own amber MFD style), not raster overlays, so
 *     none of SrvSurvey's image-alignment fields are meaningful here
 *   - our own siteType/variant naming (matches data/guardianSiteTypes.json,
 *     e.g. "structure"/"medium-001" instead of a bare "Robolobster" key)
 *
 * Usage:
 *   node scripts/convert-guardian-templates.js /path/to/SrvSurvey-main
 *
 * Safe to re-run if SrvSurvey publishes updated survey data — it always
 * regenerates both output files from scratch.
 */

const fs = require('fs');
const path = require('path');

const RUIN_VARIANT = { Alpha: 'alpha', Beta: 'beta', Gamma: 'gamma' };

// SrvSurvey's structure siteType key -> our (siteType, variant), sourced
// from data/guardianSiteTypes.json's own structureVariants cross-reference
// (canonnTypeName), not re-derived here.
const STRUCTURE_VARIANT = {
  Lacrosse: 'tiny-001',
  Crossroads: 'tiny-002',
  Fistbump: 'tiny-003',
  Hammerbot: 'small-001',
  Bear: 'small-002',
  Bowl: 'small-003',
  Turtle: 'small-005',
  Robolobster: 'medium-001',
  Squid: 'medium-002',
  Stickyhand: 'medium-003',
};

// SrvSurvey POI type -> our POI type enum (docs/guardian-sites-schema.md,
// extended with component/obelisk-damaged).
const POI_TYPE_MAP = {
  obelisk: 'obelisk',
  brokeObelisk: 'obelisk-damaged',
  relic: 'relic-tower',
  casket: 'casket',
  tablet: 'tablet',
  orb: 'orb',
  urn: 'urn',
  totem: 'totem',
  pylon: 'pylon',
  component: 'component',
  unknown: 'unknown',
};

function classify(srvKey) {
  if (RUIN_VARIANT[srvKey]) return { siteType: 'ruins', variant: RUIN_VARIANT[srvKey] };
  if (STRUCTURE_VARIANT[srvKey]) return { siteType: 'structure', variant: STRUCTURE_VARIANT[srvKey] };
  return null;
}

/** Groups obelisk-family POIs by their shared alpha name-prefix (e.g. "A01","A02" -> group "A"). */
function buildObeliskGroups(pois) {
  const byPrefix = new Map();
  for (const p of pois) {
    if (p.type !== 'obelisk' && p.type !== 'obelisk-damaged') continue;
    const prefix = (p._srcName || '').match(/^[A-Za-z]+/);
    const key = prefix ? prefix[0] : '?';
    if (!byPrefix.has(key)) byPrefix.set(key, []);
    byPrefix.get(key).push(p);
  }
  const groups = [];
  for (const [key, members] of byPrefix) {
    // centroid in local xy so a tight cluster gets one representative
    // bearing/distance rather than an average-of-angles wraparound bug.
    let x = 0, y = 0;
    for (const m of members) {
      const rad = (m.bearingDeg * Math.PI) / 180;
      x += m.distanceM * Math.sin(rad);
      y += m.distanceM * Math.cos(rad);
    }
    x /= members.length; y /= members.length;
    const distanceM = Math.sqrt(x * x + y * y);
    let bearingDeg = (Math.atan2(x, y) * 180) / Math.PI;
    if (bearingDeg < 0) bearingDeg += 360;
    groups.push({
      id: `group-${key}`,
      label: `Group ${key}`,
      bearingDeg: Number(bearingDeg.toFixed(2)),
      distanceM: Number(distanceM.toFixed(2)),
      obeliskCount: members.length,
    });
  }
  return groups.sort((a, b) => a.id.localeCompare(b.id));
}

function convertTemplate(srvKey, srvTemplate) {
  const classified = classify(srvKey);
  if (!classified) return null;

  let maxDist = 0;
  const pois = srvTemplate.poi.map((p, i) => {
    maxDist = Math.max(maxDist, p.dist);
    return {
      id: `poi-${String(i + 1).padStart(3, '0')}`,
      type: POI_TYPE_MAP[p.type] || 'unknown',
      // Our own local->world convention (see guardianTemplateService.js):
      // stored as-is here, in the template's own local reference frame.
      bearingDeg: Number(p.angle.toFixed(3)),
      distanceM: Number(p.dist.toFixed(2)),
      headingDeg: p.rot != null ? Number(p.rot.toFixed(1)) : null,
      label: p.name || null,
      notes: null,
      _srcName: p.name, // internal only, stripped before writing output
    };
  });

  const obeliskGroups = buildObeliskGroups(pois);
  for (const p of pois) delete p._srcName;

  return {
    siteType: classified.siteType,
    variant: classified.variant,
    displayName: srvKey,
    scale: { widthM: Math.ceil(maxDist * 2), heightM: Math.ceil(maxDist * 2) },
    pois,
    obeliskGroups,
  };
}

function convertKnownSites(allRuins, allStructures) {
  const out = [];
  for (const r of allRuins) {
    out.push({
      systemName: r.systemName,
      systemAddress: r.systemAddress,
      bodyName: r.bodyName,
      bodyId: r.bodyId,
      siteType: 'ruins',
      variant: RUIN_VARIANT[r.siteType] || null,
      origin: { latitude: r.latitude, longitude: r.longitude },
      siteHeadingDeg: r.siteHeading,
      relicTowerHeadingDeg: r.relicTowerHeading,
      distanceToArrivalLs: r.distanceToArrival,
    });
  }
  for (const s of allStructures) {
    out.push({
      systemName: s.systemName,
      systemAddress: s.systemAddress,
      bodyName: s.bodyName,
      bodyId: s.bodyId,
      siteType: 'structure',
      variant: STRUCTURE_VARIANT[s.siteType] || null,
      origin: { latitude: s.latitude, longitude: s.longitude },
      siteHeadingDeg: s.siteHeading,
      relicTowerHeadingDeg: null,
      distanceToArrivalLs: s.distanceToArrival,
    });
  }
  return out;
}

function main() {
  const srcRoot = process.argv[2];
  if (!srcRoot) {
    console.error('Usage: node scripts/convert-guardian-templates.js /path/to/SrvSurvey-main');
    process.exit(1);
  }
  const srvSrvSurveyDir = path.join(srcRoot, 'SrvSurvey');

  const rawTemplates = JSON.parse(fs.readFileSync(path.join(srvSrvSurveyDir, 'guardianSiteTemplates.json'), 'utf8'));
  const allRuins = JSON.parse(fs.readFileSync(path.join(srvSrvSurveyDir, 'allRuins.json'), 'utf8'));
  const allStructures = JSON.parse(fs.readFileSync(path.join(srvSrvSurveyDir, 'allStructures.json'), 'utf8'));

  const templatesOut = { schemaVersion: 1, generatedFrom: 'SrvSurvey guardianSiteTemplates.json (converted)', templates: {} };
  for (const [srvKey, srvTemplate] of Object.entries(rawTemplates)) {
    const converted = convertTemplate(srvKey, srvTemplate);
    if (!converted) { console.warn(`Skipping unrecognized template key: ${srvKey}`); continue; }
    templatesOut.templates[`${converted.siteType}:${converted.variant}`] = converted;
  }

  const knownSites = convertKnownSites(allRuins, allStructures);
  const knownSitesOut = {
    schemaVersion: 1,
    generatedFrom: 'SrvSurvey allRuins.json + allStructures.json (converted)',
    generatedAt: new Date().toISOString(),
    count: knownSites.length,
    sites: knownSites,
  };

  const dataDir = path.join(__dirname, '..', 'data');
  fs.writeFileSync(path.join(dataDir, 'guardianSiteTemplates.json'), JSON.stringify(templatesOut, null, 2));
  fs.writeFileSync(path.join(dataDir, 'guardianKnownSites.json'), JSON.stringify(knownSitesOut, null, 2));

  console.log(`Wrote ${Object.keys(templatesOut.templates).length} templates -> data/guardianSiteTemplates.json`);
  console.log(`Wrote ${knownSites.length} known sites -> data/guardianKnownSites.json`);
}

main();
