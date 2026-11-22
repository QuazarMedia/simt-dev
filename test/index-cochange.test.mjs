import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';

import { mineCochange, updateCochangeHistory } from '../src/index/cochange.mjs';
import { readCochange, readCochangeBasis } from '../src/index/graph-read.mjs';
import { reindex } from '../src/index/store.mjs';
import { ensureGit, git, tempDir } from './fixture.mjs';

test('drops bulk changes, decays history by age and keeps directional confidence and lift', () => {
  const wide = Array.from({ length: 50 }, (_, index) => 'src/file-' + index + '.mjs');
  assert.deepEqual(mineCochange([wide, wide]), []);
  const tests = Array.from({ length: 9 }, (_, index) => 'test/file-' + index + '.test.mjs');
  assert.deepEqual(mineCochange([tests, tests]), []);
  const a = 'src/parser.mjs';
  const b = 'test/parser.test.mjs';
  const rows = mineCochange([[a], [a, b], wide, [a, b], ['src/unrelated.mjs']]);
  const forward = rows.find(({ src, dst }) => src === a && dst === b);
  const reverse = rows.find(({ src, dst }) => src === b && dst === a);
  const expected = (2 ** (-1 / 100) + 2 ** (-3 / 100)) / Math.log2(3);
  assert.ok(Math.abs(forward.decayedWeight - expected) < 1e-12);
  assert.equal(forward.support, 2);
  assert.ok(forward.confidence < reverse.confidence);
  assert.equal(reverse.confidence, 1);
  assert.ok(reverse.lift > 1);
});

test('caps partners by confidence and ignores pairs seen once', () => {
  const pivot = 'shared.mjs';
  const eligible = new Set([pivot]);
  const partners = Array.from({ length: 13 }, (_, index) => 'candidate-' + index + '.mjs');
  for (const path of partners) eligible.add(path);
  const commits = [[pivot, ...partners], [pivot, ...partners], [pivot, 'coincidence.mjs']];
  const rows = mineCochange(commits);
  assert.equal(rows.filter(({ src }) => src === pivot).length, 12);
  assert.ok(rows.every(({ dst }) => dst !== 'coincidence.mjs'));
  eligible.delete(partners.at(-1));
  assert.ok(mineCochange(commits, { eligible }).every(({ dst }) => eligible.has(dst)));
});

test('persists a bounded history and reads only the new linear commit', async () => {
  const root = await tempDir('index-cochange-');
  await mkdir(join(root, 'src'));
  const paths = ['src/a helper.mjs', 'src/\nb helper.mjs'];
  for (const path of paths) await writeFile(join(root, path), 'export const value = 1;');
  await ensureGit(root);
  await reindex(root);
  const first = await readCochangeBasis(root);
  assert.equal(first.commits.length, 1);
  assert.deepEqual([...first.commits[0]].sort(), [...paths].sort());
  assert.deepEqual(await readCochange(root), []);
  for (const path of paths) await writeFile(join(root, path), 'export const value = 2;');
  await git(['commit', '-am', 'update two equivalent helpers'], { cwd: root });

  const updated = await updateCochangeHistory(root, first);
  assert.equal(updated.scanned, 1);
  assert.equal(updated.rebuilt, false);
  assert.equal(updated.commits.length, 2);
  await reindex(root);
  const persisted = await readCochangeBasis(root);
  assert.equal(persisted.head, updated.head);
  const rows = await readCochange(root);
  assert.equal(rows.length, 2);
  assert.ok(rows.every(({ confidence, support }) => confidence === 1 && support === 2));
  assert.equal((await updateCochangeHistory(root, persisted)).scanned, 0);

  await git(['switch', '--detach', first.head], { cwd: root });
  const rewind = await updateCochangeHistory(root, persisted);
  assert.equal(rewind.rebuilt, true);
  assert.deepEqual(rewind.commits, first.commits);
});
