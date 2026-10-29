// How simt-dev is installed, and the version a repository holds it to.
//
// Three distinct things that must not be confused:
//   - packageVersion() is the version of the binary that is RUNNING. It is read from
//     the package this code lives in, so it is correct whether the binary was resolved
//     from node_modules, the release binary in `.simt/bin`, a global install, or a
//     source checkout.
//   - hasNpm(root) is the KIND of repository: does it have a package.json? That decides
//     how it obtains simt-dev at all — pinned as a devDependency where one exists, the
//     release binary into the repository where there is no node_modules to pin in
//     (ADR-098).
//   - the pin is the version a repository recorded when it adopted simt-dev, stored in
//     the manifest's projection.version. It is what an install outside node_modules
//     must match: npm pins the node_modules copy for us, but nothing pins a binary, so
//     the gate compares the running version against the pin and refuses on a mismatch.

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { stat } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { MANIFEST_FILE } from './name.mjs';

/**
 * The version of the simt-dev package this code is running from.
 *
 * Sync, because the render functions it feeds are sync: a rendered artifact bakes in
 * the version that produced it, and that must be known before the bytes are written.
 * A missing or unreadable package.json degrades to 'unknown' rather than throwing —
 * the same call already tolerates it in `--version`, and a render that cannot read its
 * own version is not a reason to crash the command that calls it.
 */
export function packageVersion() {
  try {
    const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
    return pkg.version;
  } catch {
    return 'unknown';
  }
}

/** The directory this package is installed in, whatever resolved the import. */
export function packageRootDir() {
  return dirname(dirname(fileURLToPath(import.meta.url)));
}

/**
 * The short commit this checkout is at, or null outside a git checkout (an
 * installed tarball or wheel has no `.git`). Read-only and best-effort: a
 * version string must never fail because the VCS is absent (Q05).
 */
export function checkoutSha() {
  try {
    const sha = execFileSync('git', ['rev-parse', '--short', 'HEAD'], {
      cwd: packageRootDir(),
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    return /^[0-9a-f]+$/.test(sha) ? sha : null;
  } catch {
    return null;
  }
}

/**
 * What `--version` prints: the package version, plus the checkout SHA when run
 * from a source tree past its tag. A `main` 26 commits past v0.6.2 reporting
 * bare `0.6.2` is the drift Q05 closes: the number alone claims a release the
 * bytes are not (Q05).
 */
export function describeVersion() {
  const version = packageVersion();
  const sha = checkoutSha();
  if (!sha) return `simt-dev ${version}`;
  try {
    const tag = execFileSync('git', ['describe', '--tags', '--exact-match'], {
      cwd: packageRootDir(),
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    if (tag === `v${version}`) return `simt-dev ${version}`;
  } catch {
    // Not exactly on the release tag: fall through to the SHA suffix.
  }
  return `simt-dev ${version} (${sha})`;
}

/**
 * Whether a repository has a package.json, i.e. whether it pins simt-dev as a
 * devDependency (npm) or must download the release binary (ADR-098). Async because the render
 * call sites that feed it (init, hooks install, the compare stale check) are all async,
 * and a missing file is an answer (false), not an error.
 */
export async function hasNpm(root) {
  try {
    await stat(join(root, 'package.json'));
    return true;
  } catch {
    return false;
  }
}

/**
 * Whether the running binary matches the version a repository pinned when it adopted
 * simt-dev. Returns null when there is nothing to refuse, otherwise a message that
 * names both versions and the one command that fixes it.
 *
 * This is the gate's fail-closed guard against a stale binary: for a repository
 * without npm, the copy is the release binary in `.simt/bin` (ADR-098) and the only
 * thing that knows which version it should be is the pin. A node_modules copy is pinned by npm itself, so its mismatch
 * is a stale manifest, which `upgrade` refreshes — the remedy is the same either way.
 *
 * A manifest with no recorded pin (adopted before the field existed) is skipped, not
 * failed: there is nothing to compare against, and failing it would turn every pre-0.2
 * repository into a red gate the moment this check ships.
 */
export function assertVersionPin(manifest) {
  const pin = manifest?.projection?.version;
  if (!pin || pin === 'unknown') return null;
  const running = packageVersion();
  if (running === pin) return null;
  return `simt-dev version mismatch: ${MANIFEST_FILE} pins ${pin}, the running binary is ${running}`;
}
