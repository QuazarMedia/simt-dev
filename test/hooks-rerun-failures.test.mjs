// ADR-258 (plan 0010, PT06): a failed `test` run that recorded failing ids exactly one
// commit below the pushed HEAD, with a test-only commit in between, re-runs exactly those
// ids on the push. Every miss - a source file in the intervening commit, a distance of
// more than one commit, no recorded ids - falls through to the threshold path, which is
// the old behaviour. The probe is the repo's `test` script: the marker is present only
// when the full suite ran.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { git, keepTemp } from './fixture.mjs';
import { runGates } from '../src/hooks/dispatcher.mjs';
import { recordRun } from '../src/ledger/index.mjs';
import { MANIFEST_FILE } from '../src/name.mjs';

const LIB = 'export const add = (a, b) => a + b;\n';
const LIB_BROKEN = 'export const add = (a, b) => a + b + 1;\n';
const TEST_JS = [
  "import assert from 'node:assert/strict';",
  "import { add } from '../src/lib.js';",
  'assert.equal(typeof add, "function");',
  '',
].join('\n');
const PROBE = [
  "import { appendFileSync } from 'node:fs';",
  "if (process.env.FULL_RAN) appendFileSync(process.env.FULL_RAN, 'full\\n');",
  '',
].join('\n');

async function repo() {
  const root = await mkdtemp(join(tmpdir(), 'simt-rerun-'));
  keepTemp(root);
  await git(['init', '-q', '.'], { cwd: root });
  // recordRun writes .simt/local/ledger.jsonl into this repo; without an exclude the
  // next `git add -A` commits it, and a non-test file in the intervening commit
  // defeats the lever under test.
  await writeFile(join(root, '.git', 'info', 'exclude'), '.simt/\n');
  await writeFile(join(root, 'package.json'), JSON.stringify({ name: 'fx', scripts: { test: 'node probe.mjs' } }, null, 2));
  await writeFile(join(root, 'probe.mjs'), PROBE);
  await writeFile(join(root, MANIFEST_FILE), JSON.stringify({ id: 'r', stack: [], gates: { prePush: ['test'] } }, null, 2));
  await mkdir(join(root, 'src'));
  await writeFile(join(root, 'src', 'lib.js'), LIB);
  await mkdir(join(root, 'test'));
  await writeFile(join(root, 'test', 'lib.test.mjs'), TEST_JS);
  await git(['add', '-A'], { cwd: root });
  await git(['commit', '-qm', 'base'], { cwd: root });
  const { stdout } = await git(['rev-parse', 'HEAD'], { cwd: root });
  return { root, baseSha: stdout.trim() };
}

async function commit(root, files, message) {
  for (const [path, body] of Object.entries(files)) {
    const target = join(root, path);
    await mkdir(join(target, '..'), { recursive: true });
    await writeFile(target, body);
  }
  await git(['add', '-A'], { cwd: root });
  await git(['commit', '-qm', message], { cwd: root });
  const { stdout } = await git(['rev-parse', 'HEAD'], { cwd: root });
  return stdout.trim();
}

/** The pre-push stdin git feeds the hook: one line, local ref and sha, remote ref and sha. */
const pushed = (localSha, remoteSha) => `refs/heads/main ${localSha} refs/heads/main ${remoteSha}\n`;

async function runPrePush(root, pushedLine) {
  const marker = join(root, 'full-ran.txt');
  process.env.FULL_RAN = marker;
  try {
    const result = await runGates('pre-push', { root, manifest: { id: 'r', stack: [], gates: { prePush: ['test'] } }, pushed: pushedLine });
    const testGate = result.gates.find((g) => g.name === 'test');
    const fullRan = await existsSync(marker);
    return { testGate, fullRan };
  } finally {
    delete process.env.FULL_RAN;
  }
}

test('a failed full run one test-only commit back re-runs only the recorded ids', async () => {
  const { root, baseSha } = await repo();
  const c1 = await commit(root, { 'src/lib.js': LIB_BROKEN }, 'break lib');
  await recordRun(root, {
    cmd: 'npm test',
    exit: 1,
    ms: 100,
    output: 'TAP version 13\nnot ok 1 - test/lib.test.mjs > add works\n',
    gate: 'test',
    kind: 'test',
    revision: c1,
    failedTests: ['test/lib.test.mjs > add works'],
  });
  const c2 = await commit(root, { 'test/lib.test.mjs': `${TEST_JS}// fix\n` }, 'fix test');
  const { testGate, fullRan } = await runPrePush(root, pushed(c2, c1));

  assert.equal(testGate.status, 'passed');
  assert.match(String(testGate.detail), /re-run of 1 failing test/);
  assert.equal(fullRan, false, 'the full suite ran on a re-run push');
});

test('a source file in the intervening commit falls through to the threshold path', async () => {
  const { root } = await repo();
  const c1 = await commit(root, { 'src/lib.js': LIB_BROKEN }, 'break lib');
  await recordRun(root, {
    cmd: 'npm test',
    exit: 1,
    ms: 100,
    output: 'TAP version 13\nnot ok 1 - test/lib.test.mjs > add works\n',
    gate: 'test',
    kind: 'test',
    revision: c1,
    failedTests: ['test/lib.test.mjs > add works'],
  });
  const c2 = await commit(root, { 'src/lib.js': LIB }, 'fix lib');
  const { testGate, fullRan } = await runPrePush(root, pushed(c2, c1));

  assert.equal(testGate.status, 'passed');
  assert.match(String(testGate.detail), /focused:/);
  assert.doesNotMatch(String(testGate.detail), /re-run/);
  assert.equal(fullRan, false, 'the one-commit push took the focused path, not the full suite');
});

test('a failed run two commits below the pushed HEAD falls through', async () => {
  const { root, baseSha } = await repo();
  await recordRun(root, {
    cmd: 'npm test',
    exit: 1,
    ms: 100,
    output: 'TAP version 13\nnot ok 1 - test/lib.test.mjs > add works\n',
    gate: 'test',
    kind: 'test',
    revision: baseSha,
    failedTests: ['test/lib.test.mjs > add works'],
  });
  const c1 = await commit(root, { 'test/lib.test.mjs': `${TEST_JS}// one\n` }, 'one');
  const c2 = await commit(root, { 'test/lib.test.mjs': `${TEST_JS}// two\n` }, 'two');
  const { testGate, fullRan } = await runPrePush(root, pushed(c2, baseSha));

  assert.equal(testGate.status, 'passed');
  assert.doesNotMatch(String(testGate.detail), /re-run/);
  assert.equal(fullRan, true, 'the two-commit push kept the full suite');
});

test('a crash failure with no recorded ids falls through to the full suite', async () => {
  const { root, baseSha } = await repo();
  const c1 = await commit(root, { 'src/lib.js': LIB_BROKEN }, 'break lib');
  await recordRun(root, { cmd: 'npm test', exit: 1, ms: 100, output: 'it exploded\n', gate: 'test', kind: 'test', revision: c1 });
  const c2 = await commit(root, { 'test/lib.test.mjs': `${TEST_JS}// fix\n` }, 'fix test');
  const { testGate, fullRan } = await runPrePush(root, pushed(c2, baseSha));

  assert.equal(testGate.status, 'passed');
  assert.doesNotMatch(String(testGate.detail), /re-run/);
  assert.equal(fullRan, true, 'the two-commit push kept the full suite');
});
