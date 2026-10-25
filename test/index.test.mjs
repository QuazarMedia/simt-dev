// The local index (R20, ADR-089).
//
// Two properties. The same blobs come back as the same rows, on both backends. A
// one-file change rewrites that row and leaves the others, in under 300 ms.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { git } from './fixture.mjs';
import { readFiles, reindex } from '../src/index/store.mjs';
import { indexCommand } from '../src/commands/repoindex.mjs';

async function repo() {
  const root = await mkdtemp(join(tmpdir(), 'idx-'));
  await git(['init', '-q', root]);
  await mkdir(join(root, 'apps', 'web', 'src'), { recursive: true });
  await writeFile(join(root, 'apps', 'web', 'package.json'), '{ "name": "web" }\n');
  await writeFile(join(root, 'apps', 'web', 'src', 'a.ts'), 'export const a = 1;\n');
  await writeFile(join(root, 'README'), 'hello\n');
  for (let i = 0; i < 40; i += 1) {
    await writeFile(join(root, 'apps', 'web', 'src', `f${i}.js`), `export const n = ${i};\n`);
  }
  await git(['-C', root, 'add', '-A']);
  await git(['-C', root, 'commit', '-qm', 'initial']);
  return root;
}

async function sameRows(root, backend) {
  const first = await reindex(root, { backend });
  const rows = await readFiles(root, { backend });
  await rm(join(root, backend === 'sqlite' ? '.simt/index.sqlite' : '.simt/index.jsonl'));
  const second = await reindex(root, { backend });
  const again = await readFiles(root, { backend });
  assert.deepEqual(again, rows);
  assert.equal(second.updated, rows.length);
  assert.equal(first.files, rows.length);
  const web = rows.find((row) => row.path === 'apps/web/src/a.ts');
  assert.equal(web.lang, 'typescript');
  assert.equal(web.pkg, 'apps/web');
  assert.equal(rows.find((row) => row.path === 'README').lang, '');
  return rows;
}

test('sqlite rows are a function of the blobs', async () => {
  const root = await repo();
  await sameRows(root, 'sqlite');
  await rm(root, { recursive: true, force: true });
});

test('the jsonl fallback stores the same rows', async () => {
  const root = await repo();
  await sameRows(root, 'jsonl');
  await rm(root, { recursive: true, force: true });
});

test('one changed file is the only row rewritten, in under 300 ms', async () => {
  const root = await repo();
  await reindex(root, { backend: 'sqlite' });
  const before = await readFiles(root, { backend: 'sqlite' });
  await writeFile(join(root, 'apps', 'web', 'src', 'f0.js'), 'export const n = 99;\n');
  await git(['-C', root, 'add', 'apps/web/src/f0.js']);
  const again = await reindex(root, { backend: 'sqlite' });
  assert.equal(again.updated, 1);
  assert.ok(again.ms < 300, `reindex took ${again.ms} ms`);
  const after = await readFiles(root, { backend: 'sqlite' });
  const changed = after.filter((row, i) => row.blob !== before[i].blob);
  assert.deepEqual(changed.map((row) => row.path), ['apps/web/src/f0.js']);
  await rm(root, { recursive: true, force: true });
});

test('a removed path leaves the index', async () => {
  const root = await repo();
  await reindex(root, { backend: 'jsonl' });
  await git(['-C', root, 'rm', '-q', 'README']);
  await git(['-C', root, 'commit', '-qm', 'drop readme']);
  const result = await reindex(root, { backend: 'jsonl' });
  assert.equal(result.removed, 1);
  const rows = await readFiles(root, { backend: 'jsonl' });
  assert.equal(rows.some((row) => row.path === 'README'), false);
  await rm(root, { recursive: true, force: true });
});

test('index refuses a directory that is not a repository', async () => {
  const root = await mkdtemp(join(tmpdir(), 'idx-'));
  assert.equal(await indexCommand([], { root }), 5);
  await rm(root, { recursive: true, force: true });
});
