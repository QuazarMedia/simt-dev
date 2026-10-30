// Diff-aware gates (R16, ADR-094).
//
// A change selects the test files that import it, directly or through other
// files. Selection is asserted on a synthetic graph below, so the test does
// not duplicate the checkout's import graph and does not widen whenever an
// unrelated test gains an import. The end-to-end gate run is asserted on a
// real fixture repository.

import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { test } from 'node:test';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

import { gateCommand } from '../src/commands/gate.mjs';
import { selectTests } from '../src/index/gate.mjs';

const exec = promisify(execFile);

test('selection follows importers and stops at a test that does not reach the change', () => {
  const imports = [
    { src: 'src/mid.mjs', dst: 'src/keep.mjs', kind: 'import' },
    { src: 'test/keep.test.mjs', dst: 'src/mid.mjs', kind: 'import' },
    { src: 'test/other.test.mjs', dst: 'src/other.mjs', kind: 'import' },
    { src: 'src/keep.mjs', dst: 'src/mid.mjs', kind: 'import' },
  ];
  assert.deepEqual(selectTests(['src/keep.mjs'], imports), ['test/keep.test.mjs']);
  assert.deepEqual(selectTests(['test/keep.test.mjs'], imports), ['test/keep.test.mjs']);
  assert.deepEqual(selectTests(['src/lonely.mjs'], imports), []);
});

test('gate runs the importing test and leaves the other one', async () => {
  const root = await mkdtemp(join(tmpdir(), 'idx-gate-'));
  try {
    await git(['init', '-q', root]);
    await mkdir(join(root, 'src'), { recursive: true });
    await mkdir(join(root, 'test'), { recursive: true });
    await writeFile(join(root, 'package.json'), '{ "scripts": { "test": "node --test" } }\n');
    await writeFile(join(root, 'src', 'keep.mjs'), 'export const keep = 1;\n');
    await writeFile(join(root, 'src', 'other.mjs'), 'export const other = 1;\n');
    await writeFile(
      join(root, 'test', 'keep.test.mjs'),
      "import { test } from 'node:test';\nimport assert from 'node:assert/strict';\nimport { keep } from '../src/keep.mjs';\ntest('keeps the value', () => { assert.equal(keep, 1); });\n",
    );
    await writeFile(
      join(root, 'test', 'other.test.mjs'),
      "import { test } from 'node:test';\nimport { other } from '../src/other.mjs';\ntest('other', () => { if (other !== 1) throw new Error('other'); });\n",
    );
    await git(['-C', root, 'add', '-A']);
    await git(['-C', root, 'commit', '-qm', 'initial']);

    const ran = await capture(() => gateCommand(['src/keep.mjs'], { root }));
    assert.equal(ran.code, 0);
    assert.match(ran.stdout, /^selected  1\n/);
    assert.match(ran.stdout, /test\/keep\.test\.mjs/);
    assert.equal(ran.stdout.includes('test/other.test.mjs'), false);

    const quiet = await capture(() => gateCommand([], { root, changed: true }));
    assert.equal(quiet.code, 0);
    assert.match(quiet.stdout, /selected  0/);

    await writeFile(join(root, 'src', 'keep.mjs'), 'export const keep = 2;\n');
    const diff = await capture(() => gateCommand([], { root, changed: true }));
    assert.equal(diff.code, 1);
    assert.match(diff.stdout, /keeps the value/);

    const bare = await mkdtemp(join(tmpdir(), 'idx-gate-'));
    const refused = await capture(() => gateCommand(['src/keep.mjs'], { root: bare }));
    assert.equal(refused.code, 5);
    const usage = await capture(() => gateCommand([], { root }));
    assert.equal(usage.code, 2);
    await rm(bare, { recursive: true, force: true });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('gate --changed sees a modified non-ASCII path (Q39)', async () => {
  // Without `-z`, `git diff --name-only` C-quotes the path and the quoted form
  // matches nothing in the index, so the change selects no tests.
  const root = await mkdtemp(join(tmpdir(), 'idx-gate-'));
  try {
    await git(['init', '-q', root]);
    await mkdir(join(root, 'src'), { recursive: true });
    await mkdir(join(root, 'test'), { recursive: true });
    await writeFile(join(root, 'package.json'), '{ "scripts": { "test": "node --test" } }\n');
    await writeFile(join(root, 'src', 'ünï.mjs'), 'export const uni = 1;\n');
    await writeFile(
      join(root, 'test', 'uni.test.mjs'),
      "import { test } from 'node:test';\nimport assert from 'node:assert/strict';\nimport { uni } from '../src/ünï.mjs';\ntest('uni', () => { assert.equal(uni, 1); });\n",
    );
    await git(['-C', root, 'add', '-A']);
    await git(['-C', root, 'commit', '-qm', 'initial']);
    await writeFile(join(root, 'src', 'ünï.mjs'), 'export const uni = 2;\n');
    const diff = await capture(() => gateCommand([], { root, changed: true }));
    assert.equal(diff.code, 1, diff.stdout);
    assert.match(diff.stdout, /test\/uni\.test\.mjs/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

function git(args) {
  return exec('git', ['-c', 'user.name=simt-dev tests', '-c', 'user.email=tests@example.com', '-c', 'commit.gpgsign=false', ...args], { maxBuffer: 16 << 20 });
}

async function capture(run) {
  const chunks = [];
  const errors = [];
  const stdout = process.stdout.write;
  const stderr = process.stderr.write;
  process.stdout.write = (chunk) => {
    chunks.push(String(chunk));
    return true;
  };
  process.stderr.write = (chunk) => {
    errors.push(String(chunk));
    return true;
  };
  try {
    const code = await run();
    return { code, stdout: chunks.join(''), stderr: errors.join('') };
  } finally {
    process.stdout.write = stdout;
    process.stderr.write = stderr;
  }
}
