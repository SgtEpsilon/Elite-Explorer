// scripts/tag-release.js
//
// Runs before electron-builder publishes a release. Creates (and pushes)
// a git tag matching the current package.json version, pointed at whatever
// commit/branch is currently checked out.
//
// Why this exists: electron-builder's GitHub publish config has no
// "target branch" option. When it asks GitHub to create a release for a
// tag that doesn't exist yet, GitHub creates that tag against the repo's
// DEFAULT branch (e.g. "main") — not the branch you actually built from.
// Pre-creating the tag ourselves, on the correct commit, avoids that
// fallback entirely: GitHub just attaches the release to the tag we
// already pushed.
//
// Usage: called automatically via the "publish:beta" / "publish:stable"
// npm scripts — see package.json changes in the accompanying instructions.

const { execSync } = require('child_process');

function run(cmd) {
  return execSync(cmd, { stdio: 'pipe' }).toString().trim();
}

function main() {
  const pkg = require('../package.json');
  const tag = `v${pkg.version}`;

  const branch = run('git rev-parse --abbrev-ref HEAD');
  const sha = run('git rev-parse --short HEAD');
  console.log(`[tag-release] Current branch: ${branch} (${sha})`);
  console.log(`[tag-release] Target tag: ${tag}`);

  // Does the tag already exist locally or on origin?
  let localTagExists = false;
  try {
    run(`git rev-parse ${tag}`);
    localTagExists = true;
  } catch {
    // tag doesn't exist locally yet
  }

  let remoteTagSha = null;
  try {
    const lsRemoteOut = run(`git ls-remote --tags origin refs/tags/${tag}`);
    if (lsRemoteOut) {
      remoteTagSha = lsRemoteOut.split(/\s+/)[0];
    }
  } catch {
    // ls-remote failing isn't fatal — just means we couldn't check
    console.warn('[tag-release] Warning: could not check remote tags (network/auth issue?). Continuing.');
  }

  if (remoteTagSha) {
    // Tag already exists on origin — make sure it points at THIS commit.
    const headSha = run('git rev-parse HEAD');
    if (remoteTagSha === headSha) {
      console.log(`[tag-release] Tag ${tag} already exists on origin and matches current HEAD. Nothing to do.`);
      return;
    } else {
      console.error(
        `[tag-release] ERROR: Tag ${tag} already exists on origin but points at a DIFFERENT commit ` +
        `(${remoteTagSha.slice(0, 7)}) than your current HEAD (${headSha.slice(0, 7)}).\n` +
        `This usually means a previous release already used this version number.\n` +
        `Bump the version in package.json, or if you're intentionally re-releasing, delete the old tag first:\n` +
        `  git push origin --delete ${tag}\n` +
        `  git tag -d ${tag}\n` +
        `and also delete the corresponding GitHub Release in the web UI before retrying.`
      );
      process.exit(1);
    }
  }

  if (!localTagExists) {
    console.log(`[tag-release] Creating local tag ${tag} at ${sha}...`);
    run(`git tag ${tag}`);
  }

  console.log(`[tag-release] Pushing ${tag} to origin...`);
  run(`git push origin ${tag}`);
  console.log(`[tag-release] Done. ${tag} now points at ${branch} (${sha}).`);
}

try {
  main();
} catch (err) {
  console.error('[tag-release] Failed:', err.message || err);
  process.exit(1);
}
