# Guardian Sites — data schema

**Update:** as of the template-data integration, the POI *geometry* itself
(which obelisk sits where, relative to a site's origin) is no longer
independently sourced — it's converted from SrvSurvey's surveyed data
(GPL-3.0, same license as this project; see `ATTRIBUTION.md` and
`scripts/convert-guardian-templates.js`). The *schema* below — field names,
POI taxonomy, obelisk-grouping, and the SQLite cache shape — remains our own
design, reshaped from SrvSurvey's file format rather than reusing it, and
Canonn's live API is now a secondary fallback rather than the primary data
path (see `engine/services/guardianTemplateService.js`).

## Files

- `data/guardianSiteTypes.json` — **static, hand-authored** reference table
  mapping known `$Ancient_*` journal identifiers to a site type + variant.
  Small and fully ours; not fetched from anywhere.
- `data/guardianSiteTemplates.json` — **static** per-`(siteType, variant)`
  POI layout (obelisks, relic towers, caskets, etc. as bearing/distance from
  a site origin), converted from SrvSurvey's surveyed geometry. See
  `ATTRIBUTION.md`.
- `data/guardianKnownSites.json` — **static** bootstrap list of known site
  instances (system, body, lat/long, real-world heading), also converted
  from SrvSurvey's community-contributed location data. Seeds
  `guardian_sites` on first launch via `bootstrapKnownSites()`; a real
  journal sighting always takes priority over this bootstrap data.
- `guardian_sites` / `guardian_site_pois` (SQLite tables, in the existing
  `explorer.db`) — **dynamic cache**, keyed by
  `(systemAddress, bodyId, siteType)`, filled primarily from the local
  template dataset above (via `applyTemplate()`) and secondarily from
  Canonn's API for anything the template dataset doesn't cover. This is the
  runtime equivalent of a `data/guardianSites.json` file — we cache into the
  existing db instead of a flat file so it survives alongside everything
  else the app already persists, but the *shape* of each cached record is
  the schema below.

## Per-site record shape

```jsonc
{
  "systemAddress": 3107576787058,       // journal SystemAddress — our cache key, not a name (names change)
  "bodyId": 3,                           // journal BodyID
  "bodyName": "Synuefe XR-H d11-102 2 a",
  "siteType": "ruins",                   // "ruins" | "structure" (see siteTypes below)
  "variant": "tiny-001",                 // from guardianSiteTypes.json, e.g. ruins size/layout code
  "origin": {                            // local site origin — the anchor everything else is relative to
    "latitude": -8.4231,
    "longitude": 145.9102
  },
  "scale": {                             // approximate footprint, meters — for choosing a viewbox, not precision
    "widthM": 260,
    "heightM": 260
  },
  "pois": [
    {
      "id": "poi-0001",
      "type": "relic-tower",             // see POI type enum below
      "bearingDeg": 42.5,                // bearing from origin, degrees, 0 = north
      "distanceM": 38.2,                 // straight-line distance from origin, meters
      "label": "Relic Tower A",
      "notes": null
    }
  ],
  "obeliskGroups": [                      // ruins-only; structures leave this []
    {
      "id": "group-A",
      "label": "Group A",
      "bearingDeg": 10.0,
      "distanceM": 55.0,
      "obeliskCount": 4
    }
  ],
  "source": "template",                  // "template" | "community-dataset" | "canonn" | "journal" | "manual"
  "canonnSiteId": "12345",               // Canonn's own record id, if this site was ever Canonn-enriched
  "siteHeadingDeg": 332,                 // real-world rotation of the template into this site instance
  "fetchedAt": "2026-07-29T18:04:00Z",
  "schemaVersion": 1
}
```

### POI `type` enum (ours)

`relic-tower` · `obelisk` · `casket` · `tablet` · `orb` · `urn` · `totem` ·
`pylon` · `unknown`

### `siteType` enum (ours)

`ruins` · `structure`

Canonn's own type/category strings (whatever they turn out to be — see the
open question in the API section below) get mapped into this small enum plus
a free-text `variant`, rather than passed through verbatim. That mapping
table is `data/guardianSiteTypes.json`, described next.

## `data/guardianSiteTypes.json` — journal identifier → site type

This is the independent mapping from the `ApproachSettlement` journal event's
`Name` field to a site type, built by hand from the public journal manual
(https://elite-journal.readthedocs.io/) and cross-referenced against our own
`CodexEntry` observations — **not** derived from any other tool's source.

`Name` looks like `"$Ancient_Tiny_001:#index=1;"`. We strip the `$` prefix,
the trailing `:#index=N;`, and the `_NNN` suffix, and look up what's left:

| Prefix (after stripping)      | siteType    | notes                                   |
|--------------------------------|------------|------------------------------------------|
| `Ancient`                      | `ruins`     | Alpha/Beta/Gamma "broken ground" ruins   |
| `Ancient_Tiny`                  | `structure` | tiny structure layout (e.g. Lacrosse)    |
| `Ancient_Small`                 | `structure` | small structure layout (e.g. Hammerbot)  |
| `Ancient_Medium`                | `structure` | medium structure layout (e.g. Robolobster)|

**Correction (schemaVersion 2):** an earlier draft of this table had ruins
and structures swapped. Cross-referencing Canonn's public `/grtypes` and
`/gstypes` endpoints confirmed the fix: `/grtypes` (Guardian Ruins — Alpha/
Beta/Gamma) lists an **empty** `journalName` for every type, meaning the
journal doesn't disambiguate ruin type at all — bare `$Ancient` is all we
ever get for a ruin. `/gstypes` (Guardian Structures) is the one that
actually carries `journalName` values like `ancient_tiny_001` mapped to
named layouts (Lacrosse, Hammerbot, Robolobster, …), confirming the sized
`$Ancient_Tiny/Small/Medium_NNN` forms belong to structures, not ruins.
See `data/guardianSiteTypes.json`'s `structureVariants` array for the full
cross-reference list.

The `_NNN` numeric suffix (e.g. `_001`) is kept as the `variant` (e.g.
`tiny-001`) and, for structures, maps 1:1 to a named layout per Canonn's
`/gstypes` table. Ruins have no such per-layout journal signal — telling
Alpha/Beta/Gamma apart requires matching our recorded lat/long origin
against Canonn's own site data for that system, not the journal alone.
This table starts deliberately small and is meant to be extended only from
things we can
verify ourselves (in-game + `CodexEntry`), not copied from a reference we
haven't checked.

`CodexEntry` fallback: when `SubCategory` is `"$Codex_SubCategory_Guardian;"`,
we take the `Name`/`Name_Localised` pair as a secondary label and the
`Latitude`/`Longitude` fields as a location fix, used to confirm or fill in
`origin` if `ApproachSettlement` wasn't seen (e.g. player scanned a Codex
entry without an approach-settlement trigger, which can happen at range).

## Resolved: Canonn field-shape uncertainty is no longer load-bearing

The earlier open question here was about pinning down Canonn's exact
`activeObelisks`/`activeGroups` field names before `guardianSitesService.js`
could render a real site. That's no longer on the critical path: the local
template dataset (`data/guardianSiteTemplates.json`, converted from
SrvSurvey — see `ATTRIBUTION.md`) now supplies full POI geometry for the 13
known site types with no API call at all. `canonnClient.js` and
`extractPois()`/`extractObeliskGroups()` in `guardianSitesService.js` are
kept as-is and still run as a fallback for any site type the local dataset
doesn't cover, but `probe-guardian.js`'s live-verification step is no longer
a blocker for the renderer — it's only useful now if you want to firm up
the Canonn fallback path for its own sake.
