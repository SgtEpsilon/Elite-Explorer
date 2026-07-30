# Guardian Sites — data schema (original design)

This is our own schema, designed from scratch for Elite Explorer. It does not
reuse SrvSurvey's field names or structure. Anywhere our shape happens to
converge with theirs it's because both are constrained by the same underlying
geometry (bearing/distance from an origin point) and by Canonn's own field
names — not because anything was copied.

## Files

- `data/guardianSiteTypes.json` — **static, hand-authored** reference table
  mapping known `$Ancient_*` journal identifiers to a site type + variant.
  Small and fully ours; not fetched from anywhere.
- `guardian_sites` / `guardian_site_pois` (SQLite tables, in the existing
  `explorer.db`) — **dynamic cache** of what Canonn's API has told us about
  sites we've actually visited, keyed by `(systemAddress, bodyId, siteType)`.
  This is the runtime equivalent of a `data/guardianSites.json` file — we
  cache into the existing db instead of a flat file so it survives alongside
  everything else the app already persists, but the *shape* of each cached
  record is the schema below.

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
  "source": "canonn",                    // "canonn" | "manual" — provenance, not a license marker
  "canonnSiteId": "12345",               // Canonn's own record id, kept so we can re-sync/refresh a single site
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
| `Ancient`                      | `structure` | plain "Guardian Structure"               |
| `Ancient_Tiny`                  | `ruins`     | tiny ruins layout                        |
| `Ancient_Small`                 | `ruins`     | small ruins layout                       |
| `Ancient_Medium`                | `ruins`     | medium ruins layout                      |

The `_NNN` numeric suffix (e.g. `_001`) is kept as the `variant` (e.g.
`tiny-001`) since it likely distinguishes ground layouts within a size class,
but we have **not** independently verified how many distinct suffixes exist
per size or whether they map 1:1 to a physical layout. This table starts
deliberately small and is meant to be extended only from things we can
verify ourselves (in-game + `CodexEntry`), not copied from a reference we
haven't checked.

`CodexEntry` fallback: when `SubCategory` is `"$Codex_SubCategory_Guardian;"`,
we take the `Name`/`Name_Localised` pair as a secondary label and the
`Latitude`/`Longitude` fields as a location fix, used to confirm or fill in
`origin` if `ApproachSettlement` wasn't seen (e.g. player scanned a Codex
entry without an approach-settlement trigger, which can happen at range).

## Open question before Phase 2 (flagging per your instructions)

Canonn's own `/sites`-family GET endpoints (per their docs at
docs.canonn.tech) return POI data, but the docs site is explicitly
work-in-progress and I haven't been able to pin down the *exact* current
field names for individual POI bearing/distance-style data from the public
docs alone. Before I write `canonnClient.js`'s field-mapping logic in Phase 2,
I want to do one live introspection call against the real API and show you
the raw shape, rather than guess at field names and risk silently mis-mapping
something. This is purely an API-shape question, not a licensing one —
nothing about it touches SrvSurvey.
