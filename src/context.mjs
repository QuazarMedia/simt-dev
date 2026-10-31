// The per-run memo a command reads its repository through (review 0003 Q67).
//
// `check` did the same work twice in one run: `fingerprint(root)` at two sites, a
// manifest read that `manifestDrift` repeated, and a rules load that every consumer
// paid for again. Each fingerprint spawns `git ls-files` and walks the tree once per
// glob fact, so the second call was never cheap - it was invisible.
//
// The cache lives for one command, not for the process. `bench` writes manifests and
// rewrites trees mid-run; a process-lifetime memo would hand a benchmark the answer
// for a repository it had just changed, which is the one way a cache can be worse
// than no cache. A caller that wants a fresh answer makes a fresh context.
//
// A rejected computation is not cached: a transient failure (a git lock, a permission
// error) should not become the answer for the rest of the run, and every one of these
// readers is safe to retry.

import { fingerprint } from './resolve/fingerprint.mjs';
import { readManifest } from './projection/manifest.mjs';
import { loadRules, provenanceDigest } from './projection/rules.mjs';

/**
 * One repository, read once per question.
 *
 * Each accessor is a promise, and two calls with the same key share it rather than
 * racing: the first caller to ask starts the work, and everyone else awaits it.
 *
 * @param {string} root the repository this context answers for
 */
export function repoContext(root) {
  const cache = new Map();
  const counts = { hits: 0, misses: 0 };

  const once = (key, compute) => {
    if (cache.has(key)) {
      counts.hits += 1;
      return cache.get(key);
    }
    counts.misses += 1;
    const pending = Promise.resolve()
      .then(compute)
      .catch((error) => {
        // Not cached, or one failed read would answer every later caller.
        cache.delete(key);
        throw error;
      });
    cache.set(key, pending);
    return pending;
  };

  return {
    root,
    /** What the cache did, for a test or a measurement - never printed by a command. */
    get stats() {
      return { ...counts, entries: cache.size };
    },
    fingerprint: () => once('fingerprint', () => fingerprint(root)),
    // The legacy shape, because that is what the commands print: `error` is the
    // unreadable-file case and every caller already renders it. Memoising the loader's
    // `problems` array here instead gave doctor `undefined` where it tests for null.
    manifest: () => once('manifest', () => readManifest(root)),
    rules: () => once('rules', () => loadRules(root)),
    digest: () => once('digest', () => provenanceDigest()),
  };
}
