// Run before every packaged build. Fails fast (rather than shipping a build
// with cAPI silently disabled) if FRONTIER_CLIENT_ID isn't available from
// either a real environment variable or a local .env file.
const fs   = require('fs');
const path = require('path');

const envVar = process.env.FRONTIER_CLIENT_ID;

let fileHasIt = false;
const envPath = path.join(__dirname, '..', '.env');
if (fs.existsSync(envPath)) {
  const content = fs.readFileSync(envPath, 'utf8');
  fileHasIt = /^FRONTIER_CLIENT_ID=.+/m.test(content);
}

if (!envVar && !fileHasIt) {
  console.error(
    '\n[build] FRONTIER_CLIENT_ID is not set.\n' +
    '  - Local build: copy .env.example to .env and fill it in.\n' +
    '  - CI build: set FRONTIER_CLIENT_ID as an environment variable/secret.\n' +
    '  Refusing to produce a build with cAPI silently disabled.\n'
  );
  process.exit(1);
}

console.log('[build] FRONTIER_CLIENT_ID found — proceeding.');
