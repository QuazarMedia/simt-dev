// The candidate list a corpus build starts from, and what each file is in Git.
//
// Two questions, both answered without reading a file's content: which files sit inside the
// paths a scope declared, and what each one is in Git. The answer carries blob ids, not text,
// so the corpus builder can label a revision without this module deciding what a source is.
//
// A symlink is never followed. It is a candidate with `symlink: true` and no size, and the
// builder labels it without a read: following one reads a target the repository never declared.
//
// A declared path that is itself a pattern (`docs/*`) is answered from the tracked list rather
// than by walking the filesystem: a walk would read directories the pattern did not name, and a
// matched tracked path is exactly what that declaration asks for. The matcher is the one
// `resolveScope` uses, so listing and ownership cannot disagree.

import { lstat, readdir } from 'node:fs/promises';
import { join } from 'node:path';

import { git } from '../sys/git.mjs';
import { normalizePath, resolveScope } from '../work/artifacts.mjs';

const SKIP = new Set(['.git', '.simt', 'node_modules']);
const PATTERN = /[*?]/;

/** Whether a declared path needs the tracked list instead of a walk. */
const isPattern = (path) => PATTERN.test(path);

/** The directory paths a walk can start from: the literal ones, `.` for the repository root. */
function walkRoots(paths) {
  const roots = [];
  for (const raw of paths) {
    if (isPattern(raw)) continue;
    const path = normalizePath(raw);
    if (path === null) continue;
    roots.push(path === '' ? '.' : path);
  }
  return roots.length > 0 ? roots : [];
}

async function walk(root, starts, maxFiles) {
  const found = new Map();
  let truncated = false;
  const stack = [...starts];
  while (stack.length > 0) {
    const dir = stack.pop();
    let entries;
    try {
      entries = await readdir(join(root, dir === '.' ? '' : dir), { withFileTypes: true });
    } catch {
      // A declared path that does not exist contributes no candidates. `missing` is reserved
      // for a file that was listed and then could not be read.
      continue;
    }
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      const path = dir === '.' ? entry.name : `${dir}/${entry.name}`;
      if (entry.isDirectory()) {
        if (!SKIP.has(entry.name)) stack.push(path);
        continue;
      }
      const symlink = entry.isSymbolicLink();
      let bytes;
      if (!symlink) {
        try {
          bytes = (await lstat(join(root, path))).size;
        } catch {
          bytes = undefined;
        }
      }
      found.set(path, { path, bytes, symlink });
      if (found.size >= maxFiles) return { entries: found, truncated: true };
    }
  }
  return { entries: found, truncated };
}

/** `git ls-files -s` output: `<mode> <blob> <stage>\t<path>`. */
function parseIndex(stdout) {
  const map = new Map();
  for (const row of String(stdout ?? '').split('\0')) {
    const tab = row.indexOf('\t');
    if (tab === -1) continue;
    const blob = row.slice(0, tab).split(' ')[1];
    if (blob !== undefined) map.set(row.slice(tab + 1), blob);
  }
  return map;
}

/** `git ls-tree -r` output: `<mode> blob <blob>\t<path>`. */
function parseTree(stdout) {
  const map = new Map();
  for (const row of String(stdout ?? '').split('\0')) {
    const match = /^\d+ blob ([0-9a-f]+)\t(.+)$/s.exec(row);
    if (match !== null) map.set(match[2], match[1]);
  }
  return map;
}

/**
 * The candidates under the declared paths, with their Git identity.
 *
 * @param {string} root
 * @param {{paths?: string[], maxFiles?: number}} [options]
 * @returns {Promise<{candidates: object[], truncated: boolean}>}
 */
export async function inventorySources(root, { paths = ['.'], maxFiles = 2000 } = {}) {
  const declared = Array.isArray(paths) ? paths.filter((path) => typeof path === 'string' && path !== '') : [];
  const roots = walkRoots(declared);
  const walked = await walk(root, roots, maxFiles);

  // Tracked files answer three questions at once: what exists for a pattern, what the index
  // holds, and what HEAD holds. Three calls for the whole repository, not one per file.
  // `-z` is placed by hand, not appended after `--`: a helper that appends it turns it into a
  // pathspec once `--` is present.
  const scopeArgs = declared.length > 0 ? ['--', ...declared] : [];
  const nul = (stdout) => String(stdout ?? '').split('\0').filter(Boolean);
  const tracked = new Set(nul(await git(root, ['ls-files', '-z', ...scopeArgs])));
  const indexBlobs = parseIndex(await git(root, ['ls-files', '-s', '-z', ...scopeArgs]));
  const headBlobs = parseTree(await git(root, ['ls-tree', '-r', '-z', '--full-tree', 'HEAD', ...scopeArgs], { allowFailure: true }));

  let truncated = walked.truncated;
  for (const pattern of declared.filter(isPattern)) {
    for (const path of tracked) {
      if (truncated) break;
      if (walked.entries.has(path)) continue;
      if (resolveScope([{ id: pattern, paths: [pattern] }], path).scope === null) continue;
      let bytes;
      try {
        bytes = (await lstat(join(root, path))).size;
      } catch {
        bytes = undefined;
      }
      walked.entries.set(path, { path, bytes, symlink: false });
      if (walked.entries.size >= maxFiles) truncated = true;
    }
  }

  // Git-ignored paths are the repositories' own "not a source" declaration, and they are read
  // from Git rather than guessed from a name.
  const ignored = new Set();
  const untracked = [...walked.entries.values()].filter((entry) => !tracked.has(entry.path)).map((entry) => entry.path);
  if (untracked.length > 0) {
    const stdout = await git(root, ['check-ignore', '-z', '--stdin'], { allowFailure: true, input: `${untracked.join('\0')}\0` });
    for (const path of String(stdout ?? '').split('\0')) if (path !== '') ignored.add(path);
  }

  const candidates = [...walked.entries.values()]
    .sort((a, b) => a.path.localeCompare(b.path))
    .map((entry) => ({
      ...entry,
      tracked: tracked.has(entry.path),
      gitIgnored: ignored.has(entry.path),
      indexBlob: indexBlobs.get(entry.path) ?? null,
      headBlob: headBlobs.get(entry.path) ?? null,
    }));

  return { candidates, truncated };
}
