// Work out which directory git will actually run hooks from.
//
// This exists because "core.hooksPath is unset" does NOT mean "git runs no
// hooks". Unset means git falls back to the default location, which in a normal
// repository is `.git/hooks` and in a linked worktree is the *main* repository's
// `.git/hooks`. A tool that reads unset as "none" reports a live hand-written
// hook as absent, and then installs over it without asking.
//
// `git rev-parse --git-path hooks` looks like the answer and is not one:
//   normal repo, unset        -> ".git/hooks"   (relative, correct here)
//   worktree, configured      -> "hooks"        (relative to the worktree top)
//   worktree, unset           -> "./"           <- nonsense; the worktree's .git
//                                                    is a FILE, so this names the
//                                                    whole repository
// An implementation that trusted it would enumerate a worktree's entire root as
// its hooks directory and report every file in the repo as a hook. So the rule is
// resolved here, from the two facts git does report reliably.
//
// ADR-012 dropped Windows, but nothing here is POSIX-specific; the worktree
// handling is the only subtlety and it is the same on every platform.

import { execFile } from 'node:child_process';
import { readdir, stat } from 'node:fs/promises';
import { isAbsolute, join, resolve } from 'node:path';
import { promisify } from 'node:util';

const exec = promisify(execFile);

async function git(root, args) {
  const { stdout } = await exec('git', args, { cwd: root });
  return stdout.trim();
}

/**
 * The directory git runs hooks from, and which of the two rules produced it.
 *
 * @param {string} root
 * @returns {Promise<{dir:string, how:'configured'|'default'|'not-a-repo', top:string|null,
 *                    commonDir:string|null, reason?:string}>}
 */
export async function resolveHooksDir(root) {
  let top;
  try {
    top = await git(root, ['rev-parse', '--show-toplevel']);
  } catch {
    return { dir: join(root, '.git', 'hooks'), how: 'not-a-repo', top: null, commonDir: null, reason: 'not a git repository' };
  }

  let configured = null;
  try {
    const value = await git(root, ['config', '--get', 'core.hooksPath']);
    configured = value === '' ? null : value;
  } catch {
    configured = null;
  }

  // Rule 1: core.hooksPath wins. A relative value resolves against the top level
  // of the working tree, which is what makes a `hooks` directory work.
  if (configured !== null) {
    return {
      dir: isAbsolute(configured) ? configured : resolve(top, configured),
      how: 'configured',
      top,
      commonDir: null,
    };
  }

  // Rule 2: the default, which is inside the COMMON git dir. A linked worktree
  // has its own git dir but shares hooks with its parent, so this is the one
  // step where `root/.git` is the wrong answer.
  let common = '.git';
  try {
    common = await git(root, ['rev-parse', '--git-common-dir']);
  } catch {
    // A repository whose common dir cannot be read still has a working tree;
    // the top-level .git guess is the only thing left and may be right.
  }
  return {
    dir: isAbsolute(common) ? join(common, 'hooks') : resolve(top, common, 'hooks'),
    how: 'default',
    top,
    commonDir: common,
  };
}

/**
 * Executable hooks git will actually run, excluding git's own `*.sample`
 * templates and anything simt-dev generated.
 *
 * @param {string} root
 * @returns {Promise<{event:string, path:string, bytes:number}[]>}
 */
export async function foreignHooks(root) {
  const { dir, how } = await resolveHooksDir(root);
  if (how === 'not-a-repo') return [];

  let entries;
  try {
    entries = await readdir(dir);
  } catch {
    return [];
  }

  const found = [];
  for (const name of entries.sort()) {
    if (name.endsWith('.sample')) continue;
    const path = join(dir, name);
    let info;
    try {
      info = await stat(path);
    } catch {
      continue;
    }
    if (!info.isFile() || (info.mode & 0o111) === 0) continue;
    found.push({ event: name, path, bytes: info.size });
  }
  return found;
}