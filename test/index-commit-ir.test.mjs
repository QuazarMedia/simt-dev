import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';

import { buildCommitFtsRows, scoreCommitRows, truncateUtf8 } from '../src/index/commit-ir.mjs';
import { readGraph, searchCommitIr } from '../src/index/graph-read.mjs';
import { rankMapV2 } from '../src/index/map-v2.mjs';
import { SQLITE_FILE } from '../src/index/persist.mjs';
import { reindex } from '../src/index/store.mjs';
import { ensureGit, git, tempDir } from './fixture.mjs';

test('truncateUtf8 caps bytes without splitting multi-byte characters', () => {
  const text = `${'a'.repeat(509)}😀tail`;
  const truncated = truncateUtf8(text, 512);
  assert.ok(Buffer.byteLength(truncated) <= 512);
  assert.equal(truncated, 'a'.repeat(509));
});

test('commit IR excludes sprawling commits, decays by age, and combines top-2 commit scores', () => {
  const sprawling = Array.from({ length: 24 }, (_, i) => `src/bulk-${i}.mjs`);
  const rows = buildCommitFtsRows([
    { sha: 's1', paths: sprawling, subject: 'refactor OAuth refresh race condition', body: '' },
    { sha: 'r1', paths: ['src/recent.mjs'], subject: 'fix OAuth refresh race condition', body: 'handle concurrent rotation' },
    { sha: 'o1', paths: ['src/older.mjs'], subject: 'fix OAuth refresh race condition', body: 'handle concurrent rotation' },
    { sha: 'o2', paths: ['src/older.mjs'], subject: 'prevent OAuth refresh race', body: 'second fix' },
  ]);
  assert.equal(rows.some((row) => row.sha === 's1'), false);

  const ageRows = buildCommitFtsRows([
    { sha: 'recent', paths: ['src/recent.mjs'], subject: 'fix OAuth refresh race condition', body: '' },
    ...Array.from({ length: 200 }, (_, i) => ({ sha: `pad-${i}`, paths: ['src/pad.mjs'], subject: 'chore pad', body: '' })),
    { sha: 'stale', paths: ['src/stale.mjs'], subject: 'fix OAuth refresh race condition', body: '' },
  ]);
  const rankedAge = scoreCommitRows(ageRows, 'OAuth refresh race condition');
  assert.equal(rankedAge[0].path, 'src/recent.mjs');
  assert.ok(rankedAge[0].score > rankedAge[1].score);

  const pairRows = buildCommitFtsRows([
    { sha: 'single', paths: ['src/one.mjs'], subject: 'fix OAuth refresh race condition', body: '' },
    { sha: 'double-a', paths: ['src/two.mjs'], subject: 'fix OAuth refresh race condition', body: '' },
    { sha: 'double-b', paths: ['src/two.mjs'], subject: 'guard OAuth refresh race condition', body: '' },
  ]);
  const rankedPair = scoreCommitRows(pairRows, 'OAuth refresh race condition');
  assert.equal(rankedPair[0].path, 'src/two.mjs');
  assert.ok(rankedPair[0].score > rankedPair[1].score);
});

test('commit IR surfaces zero-lexical-overlap files via commit history and records --explain evidence', async () => {
  const root = await tempDir('index-commit-ir-');
  await mkdir(join(root, 'src', 'zeta'), { recursive: true });
  await mkdir(join(root, 'src', 'alpha'), { recursive: true });
  await writeFile(join(root, 'src', 'alpha', 'core.mjs'), 'export function base(x) { return x; }\n');
  await writeFile(join(root, 'src', 'alpha', 'caller.mjs'), "import { base } from './core.mjs';\nexport const run = () => base(1);\n");
  await writeFile(join(root, 'src', 'zeta', 'guard.mjs'), 'export function check(input) {\n  return Boolean(input);\n}\n');
  await ensureGit(root);
  await git(['commit', '--amend', '-m', 'fix OAuth refresh race condition\n\nHandle concurrent refresh token rotation cleanly.'], { cwd: root });
  await writeFile(join(root, 'src', 'alpha', 'core.mjs'), 'export function base(x) { return x + 1; }\n');
  await git(['commit', '-am', 'update alpha core'], { cwd: root });
  await writeFile(join(root, 'src', 'zeta', 'guard.mjs'), 'export function check(input) {\n  return input != null;\n}\n');
  await git(['commit', '-am', 'guard concurrent OAuth refresh rotation'], { cwd: root });

  await reindex(root);
  const hits = await searchCommitIr(root, 'OAuth refresh race condition');
  assert.ok(hits.some((row) => row.path === 'src/zeta/guard.mjs'));

  const graph = await readGraph(root);
  const off = await rankMapV2(root, graph, 'OAuth refresh race condition', { commitIr: false });
  const on = await rankMapV2(root, graph, 'OAuth refresh race condition', { commitIr: true, explain: true });
  assert.notEqual(off.ranked[0].path, 'src/zeta/guard.mjs');
  assert.equal(on.ranked[0].path, 'src/zeta/guard.mjs');
  const explainRow = on.evidence.find((row) => row.path === 'src/zeta/guard.mjs');
  assert.ok(explainRow?.channels.commit_ir);
  assert.equal(explainRow.channels.commit_ir.weight, 0.7);
});

test('cold or un-migrated DB returns empty commit IR results and v6 upgrades to v7 with commit_fts', async () => {
  const root = await tempDir('index-commit-ir-v6-');
  await mkdir(join(root, 'src'), { recursive: true });
  await writeFile(join(root, 'src', 'alpha.mjs'), 'export function handle(x) { return x; }\n');
  await ensureGit(root);
  await git(['commit', '--amend', '-m', 'fix retry backoff jitter'], { cwd: root });
  await reindex(root);

  const dbPath = join(root, SQLITE_FILE);
  const db = new DatabaseSync(dbPath);
  try {
    db.exec('drop table commit_fts');
    db.exec("delete from meta where key in ('commit_fts', 'commit_ir_records')");
    db.exec("update meta set value = '6' where key = 'schema'");
    db.exec('pragma user_version = 6');
  } finally {
    db.close();
  }

  assert.deepEqual(await searchCommitIr(root, 'retry backoff jitter'), []);

  await reindex(root);
  const upgraded = new DatabaseSync(dbPath, { readOnly: true });
  try {
    assert.equal(upgraded.prepare('pragma user_version').get().user_version, 7);
    assert.equal(upgraded.prepare("select value from meta where key = 'commit_fts'").get().value, '1');
  } finally {
    upgraded.close();
  }
  const hits = await searchCommitIr(root, 'retry backoff jitter');
  assert.equal(hits[0]?.path, 'src/alpha.mjs');
});
