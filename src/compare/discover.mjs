// Find the sibling repositories a `simt-dev compare` should report on.
//
// Three things here are load-bearing, and each exists because the alternative is
// a wrong answer rather than a missing one:
//
//   1. `.git` may be a DIRECTORY (a normal repo) or a FILE (a linked worktree).
//      stat-following the directory scan alone misses every worktree, and the
//      estate has one. A tool that silently omits a repo is worse than one that
//      lists it as a repo, because an agent reads absence as "nothing there".
//   2. A git worktree is not an independent consumer. It shares another repo's
//      object store and its `.git` file points at that repo's `worktrees/` entry,
//      so it must be attributed to its parent or a projection drift gets reported
//      against the wrong directory.
//   3. Directories that are not repos are not candidates, but they are still
//      COUNTED. `simt-space-review` is 25 PNG screenshots; silently dropping it
//      hides the fact that a directory in the workspace is unmanaged, which is a
//      real finding during a migration.
//
// Nothing here assumes a workspace layout, a repo count, or that simt-dev's
// siblings are git repos at all (ADR-013: the tool must be useful outside SIMT).

import { readdir, readFile, stat } from 'node:fs/promises';
import { basename, join, resolve } from 'node:path';

/** `@param {string} p` @returns {Promise<boolean>} true when `p` is a directory. */
async function isDir(p) {
  try {
    return (await stat(p)).isDirectory();
  } catch {
    return false;
  }
}

/** `@param {string} p` @returns {Promise<string|null>} file contents, or null. */
async function readIfFile(p) {
  try {
    return await readFile(p, 'utf8');
  } catch {
    return null;
  }
}

/**
 * The raw `gitdir:` pointer from a `.git` file, or null when the file is not one.
 *
 * The pointer is NOT resolved here: a relative pointer is relative to the
 * worktree, not to the process cwd, and only the caller knows the worktree.
 */
export function parseGitdirPointer(text) {
  if (typeof text !== 'string') return null;
  const match = /^gitdir:\s*(.+)$/m.exec(text.trim());
  return match ? match[1].trim() : null;
}

/**
 * Split a resolved `gitdir` path into the repo that owns the worktree and the
 * worktree's own slug, or null when the path is not a worktree entry.
 *
 * `<repo>/.git/worktrees/<slug>` - so `<slug>` is the worktree directory name with
 * its leading dot dropped and `/` turned into `-`: `.wt-wear-redesign` becomes
 * `-wt-wear-redesign`.
 */
export function ownerFromGitdir(gitdir) {
  if (!gitdir) return null;
  // The leading slash is significant: splitting on '/' and dropping empty parts
  // would turn `/a/b/.git/...` into `a/b`, a path that then resolves against the
  // cwd instead of the filesystem root. Absolute stays absolute.
  const absolute = gitdir.startsWith('/');
  const parts = gitdir.split('/').filter(Boolean);
  const at = parts.lastIndexOf('worktrees');
  if (at < 2) return null;
  const owner = parts.slice(0, at - 1).join('/');
  if (owner === '') return null;
  return { ownerDir: absolute ? `/${owner}` : owner, slug: parts[at + 1] ?? '' };
}

/**
 * Compare a worktree's directory name against its git slug.
 *
 * The slug loses the leading dot, so `.wt-wear-redesign` -> `-wt-wear-redesign`.
 * A mismatch means the directory was renamed after `git worktree add` and the
 * slug can no longer be trusted to identify which repo owns it - which is exactly
 * when reporting the wrong owner would be most damaging, because the finding
 * would be attributed to an innocent repo.
 */
export function slugMatchesDir(slug, dirName) {
  if (!slug || !dirName) return false;
  const normalise = (s) => s.replace(/^[.-]+/, '');
  return normalise(slug) === normalise(dirName);
}

/**
 * Classify one candidate directory.
 * @returns {Promise<{kind:'repo'|'worktree'|'directory'|'unreadable', gitdir?:string,
 *                    owner?:string, ownerMatches?:boolean, slug?:string}>}
 */
export async function classify(dir) {
  const git = join(dir, '.git');
  const info = await stat(git).catch(() => null);

  if (info === null) {
    // No .git at all. It may still be a readable directory (an unmanaged
    // workspace member) or not readable at all; either way it is not a repo.
    return { kind: (await isDir(dir)) ? 'directory' : 'unreadable' };
  }
  if (info.isDirectory()) return { kind: 'repo' };

  const text = await readIfFile(git);
  const raw = parseGitdirPointer(text);
  if (!raw) {
    // A .git file that is not a gitdir pointer is something else entirely, and
    // treating it as a repo would make every later command fail confusingly.
    return { kind: 'directory' };
  }

  // A relative pointer is relative to the worktree, not to the cwd.
  const gitdir = raw.startsWith('/') ? raw : resolve(dir, raw);
  const owner = ownerFromGitdir(gitdir);
  const dirName = basename(dir);
  return {
    kind: 'worktree',
    gitdir,
    owner: owner?.ownerDir ?? null,
    ownerName: owner ? basename(owner.ownerDir) : null,
    ownerMatches: owner ? slugMatchesDir(owner.slug, dirName) : false,
    slug: owner?.slug ?? null,
  };
}

/**
 * Scan `root` and classify what is there.
 *
 * Two shapes are both valid, and which one you have is a FACT of the filesystem rather
 * than something the caller has to configure (ADR-014):
 *
 *   - `root` IS a repository -> it is the single repo to report on. This is the
 *     common case outside a multi-repo workspace, and treating it as an error
 *     ("contains no git repositories") would mean the tool only works for people
 *     who happen to keep several repos together.
 *   - `root` CONTAINS repositories -> its immediate children are the estate.
 *
 * Only the second shape scans one level deep, on purpose. The estate is flat
 * siblings; a recursive walk would descend into node_modules and every build output,
 * which is unbounded work for a dashboard. A monorepo names its members explicitly
 * (ADR ruling #2).
 *
 * @returns {Promise<{root:string, shape:'repo'|'workspace', repos:string[],
 *                    worktrees:object[], directories:string[], error:string|null}>}
 */
export async function discover(root) {
  const self = await classify(root);
  if (self.kind === 'repo') {
    return { root, shape: 'repo', repos: [root], worktrees: [], directories: [], error: null };
  }
  if (self.kind === 'worktree') {
    // A worktree passed directly is attributed, never counted: its files are its
    // parent's HEAD checked out elsewhere, so reporting it as a consumer would
    // double-count one repo's drift.
    return {
      root,
      shape: 'repo',
      repos: [],
      worktrees: [{ path: root, name: basename(root), ...self }],
      directories: [],
      error: null,
    };
  }

  let entries;
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch (error) {
    return {
      root,
      shape: 'workspace',
      repos: [],
      worktrees: [],
      directories: [],
      error: error.code ?? String(error),
    };
  }

  const repos = [];
  const worktrees = [];
  const directories = [];

  for (const entry of entries) {
    // A dotfile is never a consumer: `.wt-wear-redesign` is caught as a worktree
    // below, and skipping dotdirs here only removes editor and VCS noise.
    if (entry.name.startsWith('.') && !entry.name.startsWith('.wt')) continue;
    if (!entry.isDirectory()) continue;

    const path = join(root, entry.name);
    const kind = await classify(path);
    if (kind.kind === 'repo') repos.push(path);
    else if (kind.kind === 'worktree') worktrees.push({ path, name: entry.name, ...kind });
    else if (kind.kind === 'directory') directories.push(path);
  }

  // A stable order makes two runs diffable, which is the whole point of a
  // dashboard: an agent comparing yesterday's output to today's must not be
  // reading reordering as change.
  const byName = (a, b) => basename(a).localeCompare(basename(b));
  return {
    root,
    shape: 'workspace',
    repos: repos.sort(byName),
    worktrees: worktrees.sort((a, b) => a.name.localeCompare(b.name)),
    directories: directories.sort(byName),
    error: null,
  };
}