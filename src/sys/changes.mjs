import { git, gitPaths } from './git.mjs';
import { cmp } from '../util/sort.mjs';

/** Parse NUL-delimited name status so renames and filenames with whitespace survive. */
export async function readChanges(root, { staged = false } = {}) {
  const diff = ['diff', '--name-status', '--find-renames'];
  if (staged) diff.push('--cached');
  const status = await gitPaths(root, [...diff, 'HEAD'], { maxBuffer: 8 << 20 });
  const files = new Set();
  const renames = [];
  const deleted = [];
  for (let index = 0; index < status.length;) {
    const code = status[index++];
    const path = status[index++];
    files.add(path);
    if (code.startsWith('R') || code.startsWith('C')) {
      const to = status[index++];
      renames.push({ from: path, to });
      files.add(to);
    }
    if (code.startsWith('D')) deleted.push(path);
  }
  if (!staged) {
    const untracked = await gitPaths(root, ['ls-files', '--others', '--exclude-standard'], { maxBuffer: 8 << 20 });
    for (const path of untracked) files.add(path);
  }
  return { files: [...files].sort(), renames, deleted };
}

/** Read names and patch ranges from one diff so a rename or edit cannot split their basis. */
export async function readChangeHunks(root, { staged = false } = {}) {
  const diff = ['diff', '--raw', '-z', '--patch', '--no-renames', '--unified=0',
    '--no-ext-diff', '--no-textconv', '--no-color', '--submodule=short'];
  if (staged) diff.push('--cached');
  const [raw, additions] = await Promise.all([
    git(root, [...diff, 'HEAD', '--', ':(exclude,glob)**/.env', ':(exclude,glob)**/.env.*']),
    staged ? [] : gitPaths(root, ['ls-files', '--others', '--exclude-standard']),
  ]);
  const boundary = raw.indexOf('\0\0');
  const rows = new Map();
  const paths = [];
  if (boundary !== -1) {
    const names = raw.slice(0, boundary).split('\0');
    for (let index = 0; index < names.length; index += 2) {
      const path = names[index + 1];
      const status = / ([A-Z])\d*$/u.exec(names[index])?.[1];
      rows.set(path, { path, status, hunks: [] });
      paths.push(path);
    }
    let index = -1;
    for (const line of raw.slice(boundary + 2).split('\n')) {
      if (line.startsWith('diff --git ')) index += 1;
      const match = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/u.exec(line);
      if (match && paths[index] !== undefined) {
        rows.get(paths[index]).hunks.push({ line: Number(match[1]), count: Number(match[2] ?? 1) });
      }
    }
    // Git may suppress a patch for an unmerged path. In that case the positional
    // pairing cannot prove which path owns which ranges.
    if (index + 1 !== paths.length || rows.size !== paths.length || [...rows.values()].some(({ status }) => status === 'U')) {
      for (const row of rows.values()) row.hunks = [];
    }
  }
  for (const path of additions) {
    if (!path.split('/').some((part) => /^\.env(?:\.|$)/u.test(part))) rows.set(path, { path, status: '?', hunks: [] });
  }
  return [...rows.values()].sort((a, b) => cmp(a.path, b.path));
}
