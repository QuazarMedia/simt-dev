// Everything the shipped sources import has to be inside the shipped files (W01/W48 parity).
//
// `src/commands/bench.mjs` and `src/compare/learn.mjs` import from `packages/bench/src`, and the
// `files` list did not name it: `npm pack` produced a binary whose own `simt bench` could not
// resolve its imports. A `files` entry that disagrees with the runtime reads is the failure S01
// shipped, and the check belongs on the import graph rather than on a list someone maintains.

import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { dirname, join, relative, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

async function sources(dir) {
  const out = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...(await sources(path)));
    else if (entry.name.endsWith('.mjs')) out.push(path);
  }
  return out;
}

/** Every top-level directory a relative import reaches into, other than `src/` itself. */
async function outside(importers) {
  const roots = new Map();
  for (const file of importers) {
    const text = await readFile(file, 'utf8');
    for (const match of text.matchAll(/from '(\.{1,2}\/[^']+)'/g)) {
      const target = relative(ROOT, resolve(dirname(file), match[1]));
      if (target.startsWith('..')) continue;
      const top = target.split('/')[0];
      if (top === 'src' || top === '') continue;
      if (!roots.has(top)) roots.set(top, []);
      roots.get(top).push(relative(ROOT, file));
    }
  }
  return roots;
}

const covered = (files, top) => files.some((entry) => entry === top || entry.startsWith(`${top}/`));

test('every directory the shipped sources import is in the published files list', async () => {
  const pkg = JSON.parse(await readFile(join(ROOT, 'package.json'), 'utf8'));
  const files = Array.isArray(pkg.files) ? pkg.files : [];
  const roots = await outside([...(await sources(join(ROOT, 'src'))), ...(await sources(join(ROOT, 'bin')))]);
  const missing = [...roots.entries()]
    .filter(([top]) => !covered(files, top))
    .map(([top, importers]) => `${top}/ (imported by ${[...new Set(importers)].join(', ')})`);
  assert.deepEqual(missing, [], `imported at runtime and absent from "files": ${missing.join('; ')}`);
});

test('the bench package is inside the tarball, not merely in the repository', async () => {
  const pkg = JSON.parse(await readFile(join(ROOT, 'package.json'), 'utf8'));
  assert.ok(covered(pkg.files ?? [], 'packages/bench/src'), 'packages/bench/src is not in "files"');
});
