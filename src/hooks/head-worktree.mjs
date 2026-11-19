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

import { mkdtemp, rm, stat, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { git } from '../sys/git.mjs';

/**
 * Materialize a detached worktree at one revision so a gate runs against the tree being
 * pushed, not the working one. `node_modules` is symlinked in when the real root has one,
 * because a script gate resolves its runner and binaries from there and a fresh worktree
 * does not carry it.
 *
 * The revision is a parameter rather than `HEAD` because a push can deliver several refs,
 * and only one of them — often none of them — is the caller's HEAD. Running the gates at
 * HEAD reported a result about a tree the push did not carry.
 *
 * Fails closed: a revision this repository cannot check out (an unborn HEAD, an object
 * only the remote has, an unsupported object format) returns `{ path: null }` with the
 * reason, and the caller turns that into a gate failure rather than running against a
 * tree it cannot name.
 *
 * @param {string} root the real repository root
 * @param {string} revision a rev-parse expression: a commit sha, a ref, or HEAD
 * @returns {Promise<{path: string, error?: never}|{path: null, error: string}>}
 */
async function materializeHeadWorktree(root, revision) {
  const path = await mkdtemp(join(tmpdir(), 'head-gate-'));
  try {
    await git(root, ['worktree', 'add', '--detach', path, revision]);
  } catch (error) {
    await rm(path, { recursive: true, force: true }).catch(() => {});
    return { path: null, error: `git worktree add failed for ${revision}: ${String(error.stderr ?? error.message).trim()}` };
  }
  const nodeModules = join(root, 'node_modules');
  const installed = await stat(nodeModules).then(
    () => true,
    () => false,
  );
  if (installed) {
    // Only a link that resolves: a dangling `node_modules` is an untracked path in a
    // repository that does not ignore it, which changes the tree id of an otherwise
    // clean checkout and left a passing pre-push run unable to match the tree it pushed.
    await symlink(nodeModules, join(path, 'node_modules')).catch(() => {});
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
 * @param {string} [revision] the revision being pushed; HEAD for a manual run
 * @returns {Promise<
 *   {path: string, done: () => Promise<void>, gate?: never, error?: never} |
 *   {path: null, error: string, gate: object, done?: never}
 * >}
 */
export async function preparePushTree(root, revision = 'HEAD') {
  const materialized = await materializeHeadWorktree(root, revision);
  if (materialized.path === null) {
    return {
      path: null,
      error: materialized.error,
      gate: {
        name: 'head',
        status: 'failed',
        detail: materialized.error,
        remedy: `make sure ${revision} is a commit this repository can check out, then push again`,
        adr: null,
      },
    };
  }
  return {
    path: materialized.path,
    done: () => removeHeadWorktree(root, materialized.path),
  };
}
