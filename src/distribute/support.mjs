// What runs where: the support matrix as data (ADR-206).
//
// The facts below are stated to a reader in `docs/reference/support.md`, and the test
// that reads both is the reason neither can drift. Before this module there were four
// channels each documenting its own prerequisites in a different paragraph, a release
// target list in `release.mjs`, a node floor mirrored in five files, and a download
// remedy that rendered a URL for a platform the release does not build - so a reader on
// that platform got a 404 instead of the paragraph that would have helped.
//
// Two rules keep this honest:
//
//   1. the platform list comes from TARGETS, never a second literal, because a platform
//      named here that the release does not build is a promise the release breaks;
//   2. every row's `fallback` is a thing the reader can run, not a place they can read.

import { MIN_NODE } from '../node-version.mjs';
import { TARGETS } from './release.mjs';

/** The operating systems every source channel runs on; `package.json` `os` must match. */
export const SUPPORTED_OS = ['darwin', 'linux'];

/** The oldest Python the wheel's launcher runs on; `requires-python` must match. */
export const PYTHON_FLOOR = '3.9';

/**
 * The oldest Git the worktree features need, and no older.
 *
 * `git worktree` is Git 2.5, and it is what `slice` and the head-worktree reader call.
 * The read-only commands do not require Git at all, which is why this is stated as a
 * condition on a feature rather than on the tool.
 */
export const GIT_FLOOR = '2.5';

/** Where a reader finds the table below, published with the package. */
export const SUPPORT_DOC = 'docs/reference/support.md';

const PLAIN_OS = 'macOS, Linux';

/**
 * One row per way to install the tool. `needs` is the runtime, `platforms` is where that
 * channel has an artefact, and `fallback` is what to do outside it.
 */
export const CHANNELS = [
  {
    channel: 'npm',
    install: 'npm i -D simt-dev',
    needs: `Node >= ${MIN_NODE}`,
    platforms: PLAIN_OS,
    fallback: 'install Node from nodejs.org, or use the release binary',
  },
  {
    channel: 'PyPI',
    install: 'pip install simt-dev',
    needs: `Python >= ${PYTHON_FLOOR}; Node >= ${MIN_NODE} on PATH, or the [node] extra`,
    platforms: PLAIN_OS,
    fallback: 'pip install "simt-dev[node]" brings a node with the wheel',
  },
  {
    channel: 'Homebrew',
    install: 'brew install QuazarMedia/homebrew-tap/simt-dev',
    needs: 'no runtime (the formula downloads the binary)',
    platforms: PLAIN_OS,
    fallback: 'use npm or PyPI where brew is unavailable',
  },
  {
    channel: 'release binary',
    install: 'the one-line download into .simt/bin',
    needs: 'no runtime',
    platforms: TARGETS.join(', '),
    fallback: `use npm or PyPI with Node >= ${MIN_NODE} on another platform`,
  },
];

/**
 * The channel rows, with the matrix expanded from the same literals.
 *
 * Exported as a function rather than a second constant so a caller cannot hold a copy
 * that stops being the table.
 *
 * @returns {typeof CHANNELS}
 */
export function supportRows() {
  return CHANNELS;
}
