// Impact (R23, ADR-096).
//
// A changed export lists the files that import it, the tests of that closure,
// and a contract another repository references. The list is the fixture, not
// a measurement of this checkout.

import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { test } from 'node:test';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

import { impactCommand } from '../src/commands/impact.mjs';
import { dependents, ownersOf } from '../src/index/impact.mjs';
import { reindex } from '../src/index/store.mjs';
import { TOOLS } from '../src/mcp/tools.mjs';
import { readChangeHunks } from '../src/sys/changes.mjs';
import { capture, ensureGit, simt, tempDir } from './fixture.mjs';

const exec = promisify(execFile);
const tick = String.fromCharCode(96);

test('dependents are the importers, and the last CODEOWNERS line wins', () => {
  const imports = [
    { src: 'src/use.mjs', dst: 'src/keep.mjs', kind: 'import' },
    { src: 'src/mid.mjs', dst: 'src/use.mjs', kind: 'import' },
    { src: 'test/mid.test.mjs', dst: 'src/mid.mjs', kind: 'import' },
    { src: 'src/other.mjs', dst: 'src/else.mjs', kind: 'import' },
  ];
  const reach = dependents('src/keep.mjs', imports);
  assert.deepEqual(reach.importers, ['src/mid.mjs', 'src/use.mjs']);
  assert.deepEqual(reach.tests, ['test/mid.test.mjs']);
  assert.equal(reach.truncated, false);
  const capped = dependents('src/keep.mjs', imports, 1);
  assert.equal(capped.truncated, true);
  assert.deepEqual(ownersOf('*\t@platform\nsrc/keep.mjs @api\n', 'src/keep.mjs'), ['@api']);
  assert.deepEqual(ownersOf('*\t@platform\nsrc/keep.mjs @api\n', 'src/other.mjs'), ['@platform']);
});

test('impact lists the importers, their test, and one cross-repo consumer', async () => {
  const parent = await mkdtemp(join(tmpdir(), 'idx-impact-'));
  const producer = join(parent, 'producer');
  const consumer = join(parent, 'consumer');
  try {
    await mkdir(join(producer, 'src'), { recursive: true });
    await mkdir(join(producer, 'test'), { recursive: true });
    await mkdir(join(producer, 'api'), { recursive: true });
    await mkdir(join(producer, 'docs', 'decisions'), { recursive: true });
    await mkdir(join(producer, 'rules'), { recursive: true });
    await mkdir(join(producer, '.github'), { recursive: true });
    await mkdir(join(consumer, 'src'), { recursive: true });
    await writeFile(join(producer, 'src', 'keep.mjs'), 'export function keep() { return 1; }\n');
    await writeFile(join(producer, 'src', 'use.mjs'), "import { keep } from './keep.mjs';\nexport function use() { return keep(); }\n");
    await writeFile(join(producer, 'src', 'mid.mjs'), "import { use } from './use.mjs';\nexport function mid() { return use(); }\n");
    await writeFile(join(producer, 'src', 'other.mjs'), 'export function other() { return 0; }\n');
    await writeFile(join(producer, 'test', 'mid.test.mjs'), "import { mid } from '../src/mid.mjs';\n");
    await writeFile(
      join(producer, 'api', 'openapi.json'),
      '{"openapi":"3.0.0","paths":{"/keep":{"get":{"operationId":"keep"}}}}\n',
    );
    await writeFile(
      join(producer, 'docs', 'decisions', 'ADR-001-keep.md'),
      ['# ADR-001 — keep', '', 'Status: **accepted**', '', 'Affects: ' + tick + 'src/keep.mjs' + tick, ''].join('\n'),
    );
    await writeFile(
      join(producer, 'rules', 'keep.md'),
      ['---', 'simt-id: keep', 'simt-title: keep the export', 'simt-scope: ["src/keep.mjs"]', '---', ''].join('\n'),
    );
    await writeFile(join(producer, '.github', 'CODEOWNERS'), '* @platform\nsrc/keep.mjs @api\n');
    await writeFile(join(consumer, 'src', 'client.mjs'), 'const spec = "api/openapi.json";\n');
    await writeFile(join(consumer, 'src', 'note.mjs'), 'export const note = 1;\n');
    await git(['init', '-q', producer]);
    await git(['init', '-q', consumer]);
    await git(['-C', producer, 'add', '-A']);
    await git(['-C', consumer, 'add', '-A']);
    await git(['-C', producer, 'commit', '-qm', 'producer']);
    await git(['-C', consumer, 'commit', '-qm', 'consumer']);

    const listed = await capture(() => impactCommand(['keep'], { root: producer, workspace: parent }));
    assert.equal(listed.code, 0, listed.stderr);
    assert.match(listed.stdout, /file\s+src\/keep\.mjs/);
    assert.match(listed.stdout, /symbol\s+keep/);
    assert.match(listed.stdout, /importer\s+src\/mid\.mjs/);
    assert.match(listed.stdout, /importer\s+src\/use\.mjs/);
    assert.match(listed.stdout, /test\s+test\/mid\.test\.mjs/);
    assert.match(listed.stdout, /decision\s+ADR-001\s+keep/);
    assert.match(listed.stdout, /rule\s+keep\s+keep the export/);
    assert.match(listed.stdout, /owner\s+@api/);
    assert.match(listed.stdout, /consumer\s+consumer\/src\/client\.mjs\s+api\/openapi\.json/);
    assert.equal(listed.stdout.includes('src/other.mjs'), false);
    assert.equal(listed.stdout.includes('note.mjs'), false);

    const alone = await capture(() => impactCommand(['src/keep.mjs'], { root: producer, workspace: 'off' }));
    assert.equal(alone.code, 0, alone.stderr);
    assert.match(alone.stdout, /importer\s+src\/use\.mjs/);
    assert.equal(alone.stdout.includes('consumer'), false);

    const bare = await mkdtemp(join(tmpdir(), 'idx-impact-'));
    const refused = await capture(() => impactCommand(['keep'], { root: bare }));
    assert.equal(refused.code, 5);
    await rm(bare, { recursive: true, force: true });
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});

test('impact names a non-ASCII path instead of calling it missing (Q39)', async () => {
  // Without `-z`, `git ls-files` C-quotes the path and the reader's real
  // filename matches nothing, so impact reported "not a file or an export".
  const root = await mkdtemp(join(tmpdir(), 'idx-impact-'));
  try {
    await mkdir(join(root, 'src'), { recursive: true });
    await writeFile(join(root, 'src', 'ünï.mjs'), 'export const uni = 1;\n');
    await git(['init', '-q', root]);
    await git(['-C', root, 'add', '-A']);
    await git(['-C', root, 'commit', '-qm', 'initial']);
    const listed = await capture(() => impactCommand(['src/ünï.mjs'], { root, workspace: 'off' }));
    assert.equal(listed.code, 0, listed.stderr);
    assert.match(listed.stdout, /file\s+src\/ünï\.mjs/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('impact follows a resolved Kotlin import (Q40)', async () => {
  // Before the resolve pass every dotted import stayed a raw specifier, so a
  // type used across files listed no importers. Now the edge resolves through
  // the package path and the importer is named.
  const root = await mkdtemp(join(tmpdir(), 'idx-impact-'));
  try {
    const dir = join(root, 'src', 'main', 'kotlin', 'com', 'foo');
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, 'A.kt'), 'package com.foo\nclass A\n');
    await writeFile(join(dir, 'B.kt'), 'package com.foo\nimport com.foo.A\nclass B(val a: A)\n');
    await git(['init', '-q', root]);
    await git(['-C', root, 'add', '-A']);
    await git(['-C', root, 'commit', '-qm', 'initial']);
    const listed = await capture(() =>
      impactCommand(['src/main/kotlin/com/foo/A.kt'], { root, workspace: 'off' }),
    );
    assert.equal(listed.code, 0, listed.stderr);
    assert.match(listed.stdout, /importer\s+src\/main\/kotlin\/com\/foo\/B\.kt/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('changed impact isolates an edited function and shares its facts with MCP', async () => {
  const root = await tempDir('impact-changed-');
  await mkdir(join(root, 'test'));
  const library = "export function scoreOrders() {\n  const rareReconciliationToken = 1;\n  return rareReconciliationToken;\n}\n"
    + "export function formatOrders() {\n  return 'formatted orders';\n}\n";
  const sources = {
    'library.mjs': library,
    'order-caller.mjs': "import { scoreOrders } from './library.mjs';\nexport function checkOrder() { return scoreOrders(); }",
    'format-caller.mjs': "import { formatOrders } from './library.mjs';\nexport function checkFormat() { return formatOrders(); }",
    'test/order.test.mjs': "import { checkOrder } from '../order-caller.mjs';\n",
    'test/format.test.mjs': "import { checkFormat } from '../format-caller.mjs';\n",
    'release.json': '{"build":1}',
  };
  for (const [path, body] of Object.entries(sources)) await writeFile(join(root, path), body);
  await ensureGit(root);
  await writeFile(join(root, 'library.mjs'), library.replace('Token = 1', 'Token = 2'));
  await writeFile(join(root, 'release.json'), '{"build":2}');
  await git(['-C', root, 'commit', '-qam', 'score policy and release version']);
  await writeFile(join(root, 'analogy.mjs'), library.replace('scoreOrders', 'scoreReturns').replace('formatOrders', 'formatReturns'));
  await git(['-C', root, 'add', 'analogy.mjs']);
  await git(['-C', root, 'commit', '-qm', 'add independent scoring implementation']);
  await reindex(root);
  await writeFile(join(root, 'library.mjs'), library.replace('Token = 1', 'Token = 3'));

  const cli = await simt(['impact', '--changed', '--all', '--json'], { cwd: root });
  assert.equal(cli.code, 0, cli.stderr || cli.stdout);
  const { schemaVersion, exitCode, ...changed } = JSON.parse(cli.stdout);
  assert.equal(schemaVersion, 1);
  assert.equal(exitCode, 0);
  assert.deepEqual(changed.symbols, [{ file: 'library.mjs', symbol: 'scoreOrders', lines: [1] }]);
  assert.deepEqual(changed.importers, ['order-caller.mjs']);
  assert.deepEqual(changed.tests, ['test/order.test.mjs']);
  assert.deepEqual(changed.structural.direct.map(({ path }) => path), ['order-caller.mjs']);
  assert.deepEqual(changed.testTiers.transitive.map(({ path }) => path), ['test/order.test.mjs']);
  assert.deepEqual(changed.cochange.map(({ dst }) => dst), ['release.json']);
  assert.ok(changed.conceptual.some(({ path }) => path === 'analogy.mjs'));
  assert.ok(changed.conceptual.length <= 3);
  const tool = TOOLS.find(({ name }) => name === 'impact');
  const mcp = await tool.run({ root: changed.root, changed: true, all: true });
  assert.deepEqual(JSON.parse(JSON.stringify(mcp)), changed);

  const multi = await simt(['impact', 'library.mjs#scoreOrders', 'library.mjs#formatOrders', '--json'], { cwd: root });
  assert.equal(multi.code, 0, multi.stderr || multi.stdout);
  assert.deepEqual(JSON.parse(multi.stdout).tests, ['test/format.test.mjs', 'test/order.test.mjs']);
  const task = await simt(['impact', '--task', 'Check the callers of scoreOrders', '--json'], { cwd: root });
  assert.equal(task.code, 0, task.stderr || task.stdout);
  assert.deepEqual(JSON.parse(task.stdout).tests, ['test/order.test.mjs']);

  await writeFile(join(root, 'library.mjs'), '// shared module change\n' + library.replace('Token = 1', 'Token = 3'));
  const broad = await simt(['impact', '--changed', '--json'], { cwd: root });
  assert.equal(broad.code, 0, broad.stderr || broad.stdout);
  assert.deepEqual(JSON.parse(broad.stdout).symbols, []);
  assert.equal(JSON.parse(broad.stdout).tests.length, 2);
});

test('patch ranges preserve unusual paths and deletion coordinates', async () => {
  const root = await tempDir('impact-hunks-');
  const unusual = 'a space\nand line.mjs';
  await writeFile(join(root, unusual), 'first\nsecond\nthird\n');
  await writeFile(join(root, 'b.mjs'), 'some\nlines\n');
  await ensureGit(root);
  await writeFile(join(root, unusual), 'first\nthird\n');
  await writeFile(join(root, 'b.mjs'), 'some\nelsewhere\n');
  await writeFile(join(root, 'z.mjs'), 'untracked\n');
  assert.deepEqual(await readChangeHunks(root), [
    { path: unusual, status: 'M', hunks: [{ line: 1, count: 0 }] },
    { path: 'b.mjs', status: 'M', hunks: [{ line: 2, count: 1 }] },
    { path: 'z.mjs', status: '?', hunks: [] },
  ]);
});

function git(args) {
  return exec('git', ['-c', 'user.name=simt-dev tests', '-c', 'user.email=tests@example.com', '-c', 'commit.gpgsign=false', ...args], { maxBuffer: 16 << 20 });
}

