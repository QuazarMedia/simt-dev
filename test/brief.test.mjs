// The task brief (R27).
//
// A packet is a function of the tree, the task text and the index: no clock, no locale,
// no network, no environment. These tests hold it to that, because the property that
// makes a packet reviewable is that the same input gives the same bytes — and the
// property that makes it usable is that it fits the ceiling and names what it cut.
//
// They run the real binary rather than the function, because what a reader gets is the
// binary's stdout: the one compact JSON line, the exit code, the packet as printed.

import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { promisify } from 'node:util';

import { CLI } from '../src/name.mjs';
import { git } from './fixture.mjs';

const BIN = new URL('../bin/simt.mjs', import.meta.url).pathname;

async function run(root, args) {
  try {
    const { stdout, stderr } = await promisify(execFile)('node', [BIN, ...args, '--root', root], {
      maxBuffer: 8 << 20,
    });
    return { code: 0, stdout, stderr };
  } catch (error) {
    return { code: error.code ?? 1, stdout: error.stdout ?? '', stderr: error.stderr ?? '' };
  }
}

/** A repository with one source file, one test that imports it, and a test script. */
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'brief-'));
  await git(['init', '-q', root]);
  await mkdir(join(root, 'src'), { recursive: true });
  await mkdir(join(root, 'test'), { recursive: true });
  await writeFile(
    join(root, 'package.json'),
    `${JSON.stringify({ name: 'fixture', version: '1.0.0', type: 'module', scripts: { test: 'node --test' } }, null, 2)}\n`,
  );
  await writeFile(join(root, 'README.md'), '# fixture\n');
  await writeFile(join(root, 'src', 'keep.mjs'), 'export function keep(value) {\n  return value;\n}\n');
  await writeFile(
    join(root, 'test', 'keep.test.mjs'),
    "import assert from 'node:assert/strict';\nimport { keep } from '../src/keep.mjs';\n\ntest('keep', () => assert.equal(keep(1), 1));\n",
  );
  await git(['-C', root, 'add', '-A']);
  await git(['-C', root, 'commit', '-qm', 'initial']);
  return root;
}

test('a task that names a file produces its kind, its file and its test', async (t) => {
  const root = await fixture();
  t.after(() => rm(root, { recursive: true, force: true }));
  const { code, stdout } = await run(root, ['brief', 'fix the keep helper in src/keep.mjs']);
  assert.equal(code, 0);
  assert.match(stdout, /^TASK\n/);
  assert.ok(stdout.includes('kind bugfix'), stdout);
  assert.ok(stdout.includes('src/keep.mjs'), stdout);
  assert.ok(stdout.includes('src/keep.mjs -> test/keep.test.mjs'), stdout);
  assert.ok(stdout.includes('npm run test'), stdout);
});

test('two runs of the same brief are the same bytes', async (t) => {
  const root = await fixture();
  t.after(() => rm(root, { recursive: true, force: true }));
  const first = await run(root, ['brief', 'fix the keep helper in src/keep.mjs']);
  const second = await run(root, ['brief', 'fix the keep helper in src/keep.mjs']);
  assert.equal(first.code, 0);
  assert.equal(second.stdout, first.stdout);
});

test('a packet that had to shrink fits its ceiling and says what it cut', async (t) => {
  const root = await fixture();
  t.after(() => rm(root, { recursive: true, force: true }));
  const whole = await run(root, ['brief', 'fix the keep helper in src/keep.mjs']);
  const { code, stdout } = await run(root, ['brief', 'fix the keep helper in src/keep.mjs', '--budget', '300']);
  assert.equal(code, 0);
  assert.ok(Buffer.byteLength(stdout.trimEnd()) <= 300, `${Buffer.byteLength(stdout.trimEnd())} bytes`);
  assert.ok(Buffer.byteLength(stdout) < Buffer.byteLength(whole.stdout), 'the ceiling did nothing');
  assert.match(stdout, /cut \d+ of \d+ items to fit 300: .+/);
  // What a reader cannot recover from a wrong guess is never the thing that goes.
  assert.ok(stdout.includes('npm run test'), stdout);
});

test('a budget of 0 is the whole packet, and nothing is cut', async (t) => {
  const root = await fixture();
  t.after(() => rm(root, { recursive: true, force: true }));
  const { code, stdout } = await run(root, ['brief', 'fix the keep helper in src/keep.mjs', '--budget', '0']);
  assert.equal(code, 0);
  assert.ok(!stdout.includes('cut '), stdout);
});

test('--explain names every item and why it was kept or cut', async (t) => {
  const root = await fixture();
  t.after(() => rm(root, { recursive: true, force: true }));
  const { code, stdout } = await run(root, [
    'brief',
    'fix the keep helper in src/keep.mjs',
    '--budget',
    '300',
    '--explain',
  ]);
  assert.equal(code, 0);
  assert.ok(stdout.includes('\nEXPLAIN\n'), stdout);
  assert.match(stdout, /keep TASK 1\/3 worth 8: kind bugfix/);
  assert.match(stdout, /cut \w+ \d+\/\d+ worth \d+: /);
  assert.match(stdout, /\n     the kind chooses the commands/);
});

test('--json is one compact document and carries the packet it names', async (t) => {
  const root = await fixture();
  t.after(() => rm(root, { recursive: true, force: true }));
  const { code, stdout } = await run(root, ['brief', 'fix the keep helper in src/keep.mjs', '--json']);
  assert.equal(code, 0);
  assert.equal(stdout.trim().split('\n').length, 1);
  const payload = JSON.parse(stdout);
  assert.equal(payload.schemaVersion, 1);
  assert.equal(payload.ok, true);
  assert.equal(payload.kind, 'bugfix');
  assert.equal(payload.bytes, Buffer.byteLength(payload.text));
  assert.ok(payload.sections.FILES.length > 0, stdout);
  assert.ok(payload.sections.FILES.some((line) => line.includes('src/keep.mjs')), stdout);
  assert.ok(payload.text.startsWith('TASK\n'));
});

test('the kind chooses the commands, so a docs task is not offered a build', async (t) => {
  const root = await fixture();
  t.after(() => rm(root, { recursive: true, force: true }));
  const { code, stdout } = await run(root, ['brief', 'improve the wording of the README', '--json']);
  assert.equal(code, 0);
  const payload = JSON.parse(stdout);
  assert.equal(payload.kind, 'docs');
  assert.ok(payload.sections.COMMANDS.length > 0, stdout);
  assert.ok(!payload.sections.COMMANDS.some((line) => line.includes('build')), stdout);
});

test(`the brief refuses two tasks and a budget that is not a number`, async (t) => {
  const root = await fixture();
  t.after(() => rm(root, { recursive: true, force: true }));
  const two = await run(root, ['brief', 'one', 'two']);
  assert.equal(two.code, 2);
  assert.match(two.stderr, new RegExp(`run: ${CLI} brief`, 'u'));
  const bad = await run(root, ['brief', 'one', '--budget', 'not-a-number']);
  assert.equal(bad.code, 2);
});
