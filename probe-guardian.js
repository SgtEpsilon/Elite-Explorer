/**
 * probe-guardian.js — one-off diagnostic script.
 *
 * Run this from your Elite Explorer project root with Node (it reuses your
 * existing engine/services/canonnClient.js, unmodified):
 *
 *   node probe-guardian.js "Synuefe EU-Q c21-10" structure
 *
 * It dumps Canonn's raw JSON for that system/siteType to the console AND to
 * guardian-probe-output.json in the current folder. Paste either the console
 * output or that file back to me — I need the real activeObelisks/
 * activeGroups field names to fix extractPois()/extractObeliskGroups() in
 * guardianSitesService.js, since those were built against unconfirmed field
 * guesses (see the header comment in canonnClient.js).
 *
 * Safe to delete after use — it doesn't touch your db or app state, it only
 * calls the same public Canonn endpoint the app already calls.
 */
const fs = require('fs');
const path = require('path');
const canonnClient = require('./engine/services/canonnClient');

async function main() {
  const systemName = process.argv[2];
  const siteType = process.argv[3] || 'structure'; // 'structure' | 'ruins'

  if (!systemName) {
    console.error('Usage: node probe-guardian.js "<system name>" [structure|ruins]');
    process.exit(1);
  }

  console.log(`Probing Canonn for "${systemName}" (${siteType})...`);
  const result = await canonnClient.fetchGuardianSitesForSystem(systemName, siteType);

  if (!result) {
    console.log('No response from any candidate path. Either the system has no');
    console.log('cached Guardian site in Canonn\'s database yet, or the API path');
    console.log('has drifted further than the two spellings canonnClient.js tries.');
    process.exit(0);
  }

  console.log(`Responded via: ${result.path} (restType: ${result.restType})`);
  console.log(`${result.raw.length} record(s) returned.\n`);
  console.log(JSON.stringify(result.raw, null, 2));

  const outPath = path.join(process.cwd(), 'guardian-probe-output.json');
  fs.writeFileSync(outPath, JSON.stringify(result, null, 2));
  console.log(`\nAlso saved to: ${outPath}`);
}

main().catch((err) => {
  console.error('Probe failed:', err);
  process.exit(1);
});
