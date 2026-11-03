// Where a payload's write paths resolve.
//
// A relative write path is relative to the directory the harness reported, not to the
// repository root the facts resolve against: an agent editing `keep.mjs` from `src/` means
// `src/keep.mjs`, and a path joined to the wrong base is a path the lease file will never
// meet. Two callers need this one answer — the hook that decides, and the command that
// explains the decision — and a second copy is how the two would come to disagree about
// which file a payload named.

import { isAbsolute, join } from 'node:path';

/**
 * The writes a payload names, resolved against the directory the harness reported.
 *
 * Writes are `{path, ...edit}` rows: the path resolves, and the edit detail travels
 * untouched so the region check still sees `old_string`.
 *
 * @param {string} payloadRoot
 * @param {unknown[]} writes
 * @returns {(string|object)[]}
 */
export function absoluteWrites(payloadRoot, writes = []) {
  return (Array.isArray(writes) ? writes : []).map((entry) => {
    const path = typeof entry === 'string' ? entry : entry?.path;
    // A write with no path is refused rather than dropped: a silently discarded write is a
    // mutation that escapes the lease check this resolution exists to feed.
    if (typeof path !== 'string' || path === '') throw new Error('a payload write needs a path');
    const absolute = isAbsolute(path) ? path : join(payloadRoot, path);
    return typeof entry === 'string' ? absolute : { ...entry, path: absolute };
  });
}
