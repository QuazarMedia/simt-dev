// ADR-258 (plan 0010, PT03): a push at or below `gates.prePushFocusedCommits`
// runs only the tests that import its files, recorded as `test-focused`; every
// push it cannot be sure about keeps the full suite. The probe is the repo's
// `test` script, which writes a marker only when it runs: if the marker is
// present, the full suite ran.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { git, keepTemp } from './fixture.mjs';
import { runGates } from '../src/hooks/dispatcher.mjs';
import { readLedger, recordRun } from '../src/ledger/index.mjs';
import { MANIFEST_FILE } from '../src/name.mjs';

const LIB = 'export const add = (a, b) => a + b;\n';
const LIB_CHANGED = 'export const add = (a, b) => a + b + 1;\n';
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

/**
 * The repository the threshold exercises: one module, one test importing it, a `test`
 * script that is the probe, and a manifest declaring the pre-push `test` gate.
 */
async function repo({ gates = { prePush: ['test'] } } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'simt-focused-push-'));
  keepTemp(root);
  await git(['init', '-q', '.'], { cwd: root });
  await writeFile(join(root, 'package.json'), JSON.stringify({ name: 'fx', scripts: { test: 'node probe.mjs' } }, null, 2));
  await writeFile(join(root, 'probe.mjs'), PROBE);
  await writeFile(join(root, MANIFEST_FILE), JSON.stringify({ id: 'r', stack: [], gates }, null, 2));
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

async function runPrePush(root, gates, pushedLine) {
  const marker = join(root, 'full-ran.txt');
  process.env.FULL_RAN = marker;
  try {
    const result = await runGates('pre-push', { root, manifest: { id: 'r', stack: [], gates }, pushed: pushedLine });
    const testGate = result.gates.find((g) => g.name === 'test');
    const fullRan = await existsSync(marker);
    return { result, testGate, fullRan };
  } finally {
    delete process.env.FULL_RAN;
  }
}

test('a one-commit push runs only the tests that import its files (ADR-258)', async () => {
  const gates = { prePush: ['test'] };
  const { root, baseSha } = await repo({ gates });
  const head = await commit(root, { 'src/lib.js': LIB_CHANGED }, 'change lib');
  const { testGate, fullRan } = await runPrePush(root, gates, pushed(head, baseSha));

  assert.equal(testGate.status, 'passed');
  assert.match(testGate.detail, /focused:/);
  assert.equal(fullRan, false, 'the full suite ran on a focused push');

  const { entries } = await readLedger(root);
  assert.ok(entries.some((e) => e.kind === 'test-focused' && e.exit === 0), 'no passing test-focused ledger line');
});

test('a two-commit push keeps the full suite', async () => {
  const gates = { prePush: ['test'] };
  const { root, baseSha } = await repo({ gates });
  await commit(root, { 'src/lib.js': LIB_CHANGED }, 'one');
  const head = await commit(root, { 'test/lib.test.mjs': `${TEST_JS}// second\n` }, 'two');
  const { testGate, fullRan } = await runPrePush(root, gates, pushed(head, baseSha));

  assert.equal(testGate.status, 'passed');
  assert.doesNotMatch(String(testGate.detail), /focused:/);
  assert.equal(fullRan, true, 'the full suite never ran on a push above the threshold');
});

test('a one-commit push no test imports keeps the full suite', async () => {
  const gates = { prePush: ['test'] };
  const { root, baseSha } = await repo({ gates });
  const head = await commit(root, { 'data.json': '{ "a": 1 }\n' }, 'data only');
  const { testGate, fullRan } = await runPrePush(root, gates, pushed(head, baseSha));

  assert.equal(testGate.status, 'passed');
  assert.doesNotMatch(String(testGate.detail), /focused:/);
  assert.equal(fullRan, true, 'the empty selection fell through to the full suite');
});

test('a command-kind test gate never focuses', async () => {
  const gates = { prePush: ['test'], commands: { test: 'node probe.mjs' } };
  const { root, baseSha } = await repo({ gates });
  const head = await commit(root, { 'src/lib.js': LIB_CHANGED }, 'change lib');
  const { testGate, fullRan } = await runPrePush(root, gates, pushed(head, baseSha));

  assert.equal(testGate.status, 'passed');
  assert.doesNotMatch(String(testGate.detail), /focused:/);
  assert.equal(fullRan, true, 'the command gate ran as declared');
});

test('an already-passing tree skips the test gate before the threshold (ADR-120)', async () => {
  const gates = { prePush: ['test'] };
  const { root, baseSha } = await repo({ gates });
  const head = await commit(root, { 'src/lib.js': LIB_CHANGED }, 'change lib');
  // The passing run ADR-120 accepts as evidence about this exact tree.
  await recordRun(root, { cmd: 'npm test', exit: 0, ms: 120, output: '1 pass, 0 fail', gate: 'test', kind: 'test' });
  const { testGate } = await runPrePush(root, gates, pushed(head, baseSha));

  assert.equal(testGate.status, 'skipped');
  assert.match(testGate.detail, /already passing/);
});
