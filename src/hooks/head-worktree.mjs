// The tree a pre-push gate runs in.
//
// A pre-push gate runs against the COMMITTED tree, not the working one. Uncommitted work
// must not block the push of previous commits: a gate that fails on WIP the author has not
// committed is blocking a push it does not own. The worktree is disposable and shares the
// repository's object store, so `git worktree add` is cheap and needs no clone.
//
// It lives here rather than in `dispatcher.mjs` because the dispatcher is at the file-line
// ceiling and the pre-push fix has to add to it; this module owns exactly the materialise,
// clean up and fail-closed contract.

import { mkdtemp, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { git } from '../sys/git.mjs';

/**
 * Materialize a detached worktree at HEAD so the pre-push gates run against the
 * committed tree, not the working one. `node_modules` is symlinked in when the real root
 * has one, because a script gate resolves its runner and binaries from there and a fresh
 * worktree does not carry it.
 *
 * Fails closed: an unborn HEAD (no commits) or a git error returns `{ path: null }`
 * with the reason, and the caller turns that into a gate failure rather than running
 * against a tree it cannot name.
 *
 * @param {string} root the real repository root
 * @returns {Promise<{path: string, error?: never}|{path: null, error: string}>}
 */
async function materializeHeadWorktree(root) {
  const path = await mkdtemp(join(tmpdir(), 'head-gate-'));
  try {
    await git(root, ['worktree', 'add', '--detach', path, 'HEAD']);
  } catch (error) {
    await rm(path, { recursive: true, force: true }).catch(() => {});
    return { path: null, error: `git worktree add failed: ${String(error.stderr ?? error.message).trim()}` };
  }
  const nodeModules = join(root, 'node_modules');
  try {
    await symlink(nodeModules, join(path, 'node_modules'));
  } catch {
    // Absent node_modules is the normal case for a repo with no install step; a
    // dangling link is harmless, and `npm run` does not need it to exist.
  }
  return { path };
}

/**
 * Remove a pre-push worktree. `--force` because a gate may have left it dirty (a
 * formatter, a test that writes fixtures); the worktree is disposable, the real tree
 * is not. Falls back to `rm -rf` plus a prune when git cannot remove it (a lock, a
 * path in a state git does not expect), so a cleanup failure never leaks the tree.
 *
 * @param {string} root the real repository root
 * @param {string} path the worktree to remove
 */
async function removeHeadWorktree(root, path) {
  await git(root, ['worktree', 'remove', '--force', path]).catch(async () => {
    await rm(path, { recursive: true, force: true }).catch(() => {});
    await git(root, ['worktree', 'prune']).catch(() => {});
  });
}

/**
 * Open the tree a pre-push run executes in, and the way to close it.
 *
 * The failure is a whole gate, not a message: the caller inserts it into the report and
 * returns, because a pre-push gate that cannot name its tree has nothing to run against.
 *
 * @param {string} root the real repository root
 * @returns {Promise<
 *   {path: string, done: () => Promise<void>, gate?: never, error?: never} |
 *   {path: null, error: string, gate: object, done?: never}
 * >}
 */
export async function preparePushTree(root) {
  const materialized = await materializeHeadWorktree(root);
  if (materialized.path === null) {
    return {
      path: null,
      error: materialized.error,
      gate: {
        name: 'head',
        status: 'failed',
        detail: materialized.error,
        remedy: 'commit the work, or resolve the git state so HEAD is a valid reference, then push again',
        adr: null,
      },
    };
  }
  return {
    path: materialized.path,
    done: () => removeHeadWorktree(root, materialized.path),
  };
}
