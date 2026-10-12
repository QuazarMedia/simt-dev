// How simt-dev is installed, and the version a repository holds it to.
//
// Three distinct things that must not be confused:
//   - packageVersion() is the version of the binary that is RUNNING. It is read from
//     the package this code lives in, so it is correct whether the binary was resolved
//     from node_modules, a global install, or a source checkout.
//   - hasNpm(root) is the KIND of repository: does it have a package.json? That decides
//     how it obtains simt-dev at all — pinned as a devDependency where one exists, a
//     pinned global install where there is no node_modules to pin in.
//   - the pin is the version a repository recorded when it adopted simt-dev, stored in
//     the manifest's projection.version. It is what a global install must match: npm
//     pins the node_modules copy for us, but nothing pins a global binary, so the gate
//     compares the running version against the pin and refuses on a mismatch.

import { readFileSync } from 'node:fs';
import { stat } from 'node:fs/promises';
import { join } from 'node:path';

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

/**
 * Whether a repository has a package.json, i.e. whether it pins simt-dev as a
 * devDependency (npm) or must fall back to a global install. Async because the render
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
 * This is the gate's fail-closed guard against a stale global binary: for a repository
 * without npm, simt-dev is a global install and the only thing that knows which version
 * it should be is the pin. A node_modules copy is pinned by npm itself, so its mismatch
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
