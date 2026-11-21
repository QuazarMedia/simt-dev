import { gitPaths } from './git.mjs';

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
