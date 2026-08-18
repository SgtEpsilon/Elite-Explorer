/**
 * engine/data/exoColonyRanges.js
 *
 * Minimum "clonal colony range" (the distance a commander must travel
 * before the Genetic Sampler will accept a 2nd/3rd sample of the same
 * organism) per exobiology genus, in meters.
 *
 * Keyed by the RAW internal Genus string as it appears in ScanOrganic
 * journal events (entry.Genus) — e.g. "$Codex_Ent_Bacterial_Genus_Name;" —
 * rather than the localized display name, since that's what we get live
 * off the journal and it's locale-independent.
 *
 * Values are public game knowledge, not extracted from any third-party
 * tool's source — cross-checked against the community-maintained
 * Exobiology wiki page (elite-dangerous.fandom.com/wiki/Exobiology_Sample_
 * Values_and_Details) and the Genetic Sampler wiki page. Frontier doesn't
 * publish these numbers directly, so treat entries here as best-effort:
 * if exoLiveState.js sees a genus that isn't listed, it still tracks and
 * reports raw distance-since-last-sample, it just can't say whether that
 * distance is "enough" — safer than guessing wrong. Correct/extend freely.
 */

const RANGES_M = {
  '$Codex_Ent_Bacterial_Genus_Name;':    500,   // Bacterium
  '$Codex_Ent_Shrubs_Genus_Name;':       150,   // Frutexa
  '$Codex_Ent_Cactoid_Genus_Name;':      300,   // Cactoida
  '$Codex_Ent_Fungoids_Genus_Name;':     300,   // Fungoida
  '$Codex_Ent_Tussocks_Genus_Name;':     200,   // Tussock
  '$Codex_Ent_Osseus_Genus_Name;':       800,   // Osseus
  '$Codex_Ent_Clypeus_Genus_Name;':      150,   // Clypeus
  '$Codex_Ent_Conchas_Genus_Name;':      150,   // Concha
  '$Codex_Ent_Electricae_Genus_Name;':   1000,  // Electricae
  '$Codex_Ent_Fonticulus_Genus_Name;':   500,   // Fonticulua
  '$Codex_Ent_Fumerolas_Genus_Name;':    100,   // Fumerola
  '$Codex_Ent_Recepta_Genus_Name;':      150,   // Recepta
  '$Codex_Ent_Stratum_Genus_Name;':      500,   // Stratum
  '$Codex_Ent_Tubus_Genus_Name;':        800,   // Tubus
  '$Codex_Ent_Vents_Genus_Name;':        100,   // Amphora Plant
  '$Codex_Ent_Ground_Struct_Ice_Genus_Name;': 500, // Crystalline Shards
  '$Codex_Ent_Sphere_Genus_Name;':       300,   // Anemones (approximate — anemones don't always follow the 3-sample loop)
};

/** Minimum colony range in meters for a raw Genus key, or null if unknown. */
function getColonyRangeM(genusKey) {
  if (!genusKey) return null;
  return RANGES_M[genusKey] ?? null;
}

module.exports = { RANGES_M, getColonyRangeM };
