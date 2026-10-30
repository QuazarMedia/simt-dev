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
import { isIndexStale, readEdges, readFiles, reindex } from '../src/index/store.mjs';
import { JSONL_FILE, SQLITE_FILE } from '../src/index/persist.mjs';
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
  await rm(join(root, backend === 'sqlite' ? SQLITE_FILE : JSONL_FILE));
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

for (const backend of ['sqlite', 'jsonl']) {
  test(`the tree digest marks a removal stale until the next build (${backend}, Q42)`, async () => {
    // The freshness signal is a digest compare, not a blob re-read: one
    // `git ls-files -s` against the meta row the last build vouched for.
    const root = await repo();
    try {
      assert.equal(await isIndexStale(root, { backend }), false, 'no build yet is cold, not stale');
      await reindex(root, { backend });
      assert.equal(await isIndexStale(root, { backend }), false);
      await git(['-C', root, 'rm', '-q', 'README']);
      await git(['-C', root, 'commit', '-qm', 'drop readme']);
      assert.equal(await isIndexStale(root, { backend }), true);
      await reindex(root, { backend });
      assert.equal(await isIndexStale(root, { backend }), false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
}

for (const backend of ['sqlite', 'jsonl']) {
  test(`reindexing a changed file keeps the edges pointing into it (${backend}, Q07)`, async () => {
    // The importer owns its outgoing edges: editing src/a.mjs must not delete the
    // test -> src edge, which belongs to the unchanged test file.
    const root = await mkdtemp(join(tmpdir(), 'idx-'));
    await git(['init', '-q', root]);
    await mkdir(join(root, 'src'), { recursive: true });
    await writeFile(join(root, 'src', 'a.mjs'), 'export const a = 1;\n');
    await writeFile(join(root, 'test.mjs'), "import { a } from './src/a.mjs';\nconsole.log(a);\n");
    await git(['-C', root, 'add', '-A']);
    await git(['-C', root, 'commit', '-qm', 'initial']);
    await reindex(root, { backend });
    const before = (await readEdges(root, { backend })).filter((e) => e.dst === 'src/a.mjs');
    assert.ok(before.length > 0, 'the test -> src edge is indexed');
    await writeFile(join(root, 'src', 'a.mjs'), 'export const a = 2;\n');
    await git(['-C', root, 'add', 'src/a.mjs']);
    await git(['-C', root, 'commit', '-qm', 'bump']);
    await reindex(root, { backend });
    const after = (await readEdges(root, { backend })).filter((e) => e.dst === 'src/a.mjs');
    assert.ok(after.length > 0, 'reindexing src/a.mjs kept the edge pointing into it');
    await rm(root, { recursive: true, force: true });
  });
}

test('concurrent cold indexes serialize instead of locking (sqlite, Q08)', async () => {
  // Three writers at once used to fail every run with `database is locked` and
  // leave a database with no tables. Cold builds now go to per-writer temp
  // files with an atomic rename, and incremental writes wait on the lock.
  const root = await repo();
  const runs = await Promise.all([
    reindex(root, { backend: 'sqlite' }),
    reindex(root, { backend: 'sqlite' }),
    reindex(root, { backend: 'sqlite' }),
  ]);
  for (const run of runs) assert.ok(run.files > 0, 'each concurrent run indexed the files');
  const rows = await readFiles(root, { backend: 'sqlite' });
  assert.ok(rows.length > 0, 'the database has tables and rows after concurrent writes');
  await rm(root, { recursive: true, force: true });
});

test('tracked content past the old 64 MiB buffer still indexes', async () => {
  const root = await mkdtemp(join(tmpdir(), 'idx-'));
  await git(['init', '-q', root]);
  // Just past the execFile maxBuffer (64 MiB) that used to cap the cat-file output,
  // so this fails with "stdout maxBuffer length exceeded" on the buffered code path.
  const line = 'lorem ipsum dolor sit amet\n';
  const body = line.repeat(Math.ceil((65 * 1024 * 1024) / line.length));
  await writeFile(join(root, 'large.txt'), body);
  await git(['-C', root, 'add', '-A']);
  await git(['-C', root, 'commit', '-qm', 'big']);
  const result = await reindex(root, { backend: 'jsonl' });
  assert.equal(result.files, 1);
  const rows = await readFiles(root, { backend: 'jsonl' });
  assert.equal(rows[0].bytes, Buffer.byteLength(body));
  await rm(root, { recursive: true, force: true });
});

test('index refuses a directory that is not a repository', async () => {
  const root = await mkdtemp(join(tmpdir(), 'idx-'));
  assert.equal(await indexCommand([], { root }), 5);
  await rm(root, { recursive: true, force: true });
});
