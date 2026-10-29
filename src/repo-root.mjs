// The repository root a working directory belongs to, for the hook path.
//
// A payload's `cwd` is the directory the harness happens to be in, and a harness
// happens to be in subdirectories: an agent that was told to work in `src/` edits
// from there, and every repository-relative comparison that resolves against the
// payload's cwd — the lease file, `.gitmodules`, the manifest — compares against
// the wrong root and silently stops matching (review 0003 Q16). The root this
// module answers is the one git itself would use, so a lease taken at the top
// level matches an edit made three directories down.
//
// The answer is synchronous because the caller is a hook on the hot path: one
// `git rev-parse` is cheaper than the repository walk the fallback would do in
// the common case, and the fallback only pays when git cannot answer at all —
// a directory that is not in a repository, where the walk is short by
// definition.

import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

import { MANIFEST_FILE, STATE_DIR } from './name.mjs';

/**
 * The top-level directory of the repository `cwd` is in, or `cwd` itself when it
 * is in none.
 *
 * The fallback looks for the two facts that mark a directory as adopted by this
 * tool — the state directory and the manifest — and walks up, because a hook
 * fired from a subdirectory of an adopted repository must still find it: a
 * repository with no `.git` at all (a worktree's parent, a fresh checkout
// before `git init` finishes) is the case the git call refuses and the walk
 * answers.
 */
export function repoRoot(cwd) {
  const start = resolve(String(cwd ?? ''));
  const result = spawnSync('git', ['-C', start, 'rev-parse', '--show-toplevel'], {
    encoding: 'utf8',
    timeout: 2000,
  });
  if (result.status === 0) {
    const top = String(result.stdout ?? '').trim();
    if (top !== '') return top;
  }
  let dir = start;
  for (;;) {
    if (existsSync(join(dir, STATE_DIR)) || existsSync(join(dir, MANIFEST_FILE))) return dir;
    const parent = dirname(dir);
    if (parent === dir) return start;
    dir = parent;
  }
}

/**
 * Whether git on this repository compares paths case-insensitively, which is
 * the one filesystem fact a path comparison must honour: on a case-insensitive
 * volume `NB.ipynb` and `nb.ipynb` are the file, and a comparison that spells
 * them differently is a comparison that misses.
 *
 * A git that cannot answer (no repository, no binary) answers `false`, which is
 * the strict spelling: the two case variants are then treated as distinct, the
// way they are on the filesystem the comparison is being done for.
 */
export function coreIgnoreCase(root) {
  const result = spawnSync('git', ['-C', root, 'config', '--get', 'core.ignorecase'], {
    encoding: 'utf8',
    timeout: 1000,
  });
  return result.status === 0 && String(result.stdout ?? '').trim().toLowerCase() === 'true';
}
