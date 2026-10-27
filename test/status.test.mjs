// `simt status --line` (plan 0003 R48): one line from the last `check`.
//
// The acceptance is threefold: the line is short (≤ 60 chars) and deterministic;
// it renders in well under 50 ms *without spawning the binary* — process
// startup alone costs more than the budget, which is exactly why the line reads
// a cache instead of measuring; and a round trip through a real `check` shows
// the state the gate found. Staleness is HEAD-deep only: a new commit marks
// the line, hand edits stay the documented blind spot.

import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import { readCheckCache, renderStatusLine } from '../src/status.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const BIN = resolve(HERE, '..', 'bin', 'simt.mjs');
const exec = promisify(execFile);

function git(args, options = {}) {
  return exec(
    'git',
    ['-c', 'user.name=simt-dev tests', '-c', 'user.email=tests@example.com', '-c', 'commit.gpgsign=false', ...args],
    { maxBuffer: 16 << 20, ...options },
  );
}

async function runCli(args, env = {}) {
  try {
    const { stdout, stderr } = await exec('node', [BIN, ...args], {
      maxBuffer: 16 << 20,
      env: { ...process.env, NO_COLOR: '1', SIMT_DEV_WORKSPACE: 'off', ...env },
    });
    return { code: 0, stdout, stderr };
  } catch (error) {
    return { code: error.code ?? 1, stdout: error.stdout ?? '', stderr: error.stderr ?? '' };
  }
}

async function freshRoot(t) {
  const root = await mkdtemp(join(tmpdir(), 'simt-status-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await git(['init', '-q'], { cwd: root });
  return root;
}

const SETUP_ENV = () => ({ HOME: process.env.HOME, SIMT_DEV_WORKSPACE: 'off' });

test('R48: the line is short, deterministic, and worst-case bounded', () => {
  const record = {
    version: 1,
    at: Date.now(),
    head: 'abc',
    rulesOk: true,
    hooksOk: true,
    gatesRun: 3,
    gatesTotal: 3,
    blocking: 0,
    warnings: 0,
  };
  const green = renderStatusLine(record, false);
  assert.equal(green, 'simt PASS ✓rules ✓hooks 3/3gates');
  assert.ok(green.length <= 60);

  const worst = renderStatusLine(
    { ...record, rulesOk: false, hooksOk: false, gatesRun: 0, gatesTotal: 99, blocking: 99, warnings: 99 },
    true,
  );
  assert.equal(worst, 'simt FAIL ✗rules ✗hooks 0/99gates ⚠99 stale');
  assert.ok(worst.length <= 60, `worst case is ${worst.length} chars: ${worst}`);

  // A blocking finding that fits no slot still fails the line: the outcome is
  // carried explicitly, not inferred from the symbols.
  const slotless = renderStatusLine({ ...record, blocking: 1 }, false);
  assert.match(slotless, /^simt FAIL/);
});

test('R48: read + render costs well under 50 ms', async (t) => {
  const root = await freshRoot(t);
  await writeFile(join(root, 'package.json'), '{"name":"fast"}\n', 'utf8');
  const checked = await runCli(['check', '--root', root], SETUP_ENV());
  assert.notEqual((await readCheckCache(root)), null, `check must leave a cache: ${checked.stderr.slice(0, 300)}`);

  const t0 = performance.now();
  const record = await readCheckCache(root);
  const line = renderStatusLine(record, false);
  const ms = performance.now() - t0;
  assert.ok(line.length > 0 && line.length <= 60);
  assert.ok(ms < 50, `read + render took ${ms.toFixed(1)} ms`);
});

test('R48: no cache is a miss, not an error', async (t) => {
  const root = await freshRoot(t);
  const text = await runCli(['status', '--line', '--root', root], SETUP_ENV());
  assert.equal(text.code, 0);
  assert.equal(text.stdout.trim(), 'simt no cache - run check');

  const json = await runCli(['status', '--line', '--root', root, '--json'], SETUP_ENV());
  assert.equal(json.code, 0);
  const payload = JSON.parse(json.stdout);
  assert.equal(payload.ok, true);
  assert.equal(payload.cached, false);
  assert.equal(payload.line, null);
});

test('R48: a real check round-trips into the line', async (t) => {
  const root = await freshRoot(t);
  await writeFile(join(root, 'package.json'), '{"name":"roundtrip"}\n', 'utf8');
  await git(['add', '-A'], { cwd: root });
  await git(['commit', '-qm', 'base'], { cwd: root });

  const checked = await runCli(['check', '--root', root], SETUP_ENV());
  assert.equal(checked.code, 1, 'an unadopted repo fails the gate');
  const record = await readCheckCache(root);
  assert.notEqual(record, null);
  assert.equal(record.head, (await git(['rev-parse', 'HEAD'], { cwd: root })).stdout.trim());

  const text = await runCli(['status', '--line', '--root', root], SETUP_ENV());
  assert.equal(text.code, 1, 'the line exits like the gate it reports');
  assert.equal(text.stdout.trim(), renderStatusLine(record, false));
  assert.ok(text.stdout.trim().length <= 60);

  const json = await runCli(['status', '--line', '--root', root, '--json'], SETUP_ENV());
  const payload = JSON.parse(json.stdout);
  assert.equal(payload.ok, false);
  assert.equal(payload.line, text.stdout.trim());
  assert.equal(payload.stale, false);
});

test('R48: a new commit marks the line stale', async (t) => {
  const root = await freshRoot(t);
  await writeFile(join(root, 'package.json'), '{"name":"stale"}\n', 'utf8');
  await git(['add', '-A'], { cwd: root });
  await git(['commit', '-qm', 'base'], { cwd: root });
  await runCli(['check', '--root', root], SETUP_ENV());

  const fresh = await runCli(['status', '--line', '--root', root], SETUP_ENV());
  assert.ok(!fresh.stdout.trim().endsWith('stale'));

  await git(['commit', '-qm', 'empty', '--allow-empty'], { cwd: root });
  const moved = await runCli(['status', '--line', '--root', root], SETUP_ENV());
  assert.ok(moved.stdout.trim().endsWith(' stale'), moved.stdout);
  assert.equal(moved.code, fresh.code, 'staleness marks, it does not re-judge');
});

test('R48: the line survives without git', async (t) => {
  // The whole point of "from cache": no rev-parse, no fingerprint, no rule
  // reads. An exported tree with no `.git` at all still reports the record.
  const root = await freshRoot(t);
  await writeFile(join(root, 'package.json'), '{"name":"exported"}\n', 'utf8');
  await git(['add', '-A'], { cwd: root });
  await git(['commit', '-qm', 'base'], { cwd: root });
  await runCli(['check', '--root', root], SETUP_ENV());
  const before = (await runCli(['status', '--line', '--root', root], SETUP_ENV())).stdout;

  await rm(join(root, '.git'), { recursive: true, force: true });
  const after = await runCli(['status', '--line', '--root', root], SETUP_ENV());
  assert.equal(after.stdout, before, 'no git must not change the cached answer');
});

test('R48: writers invalidate, so the line never reports a moved tree', async (t) => {
  const root = await freshRoot(t);
  const env = { HOME: await mkdtemp(join(tmpdir(), 'simt-status-home-')), SIMT_DEV_WORKSPACE: 'off' };
  t.after(() => rm(env.HOME, { recursive: true, force: true }));
  await writeFile(join(root, 'package.json'), '{"name":"moving","scripts":{"test":"exit 0"}}\n', 'utf8');
  await git(['add', '-A'], { cwd: root });
  await git(['commit', '-qm', 'base'], { cwd: root });

  await runCli(['check', '--root', root], env);
  assert.notEqual(await readCheckCache(root), null);
  // `sync --yes` rewrites the regions: the record it was measured from is gone.
  const synced = await runCli(['sync', '--root', root, '--yes'], env);
  assert.equal(synced.code, 0, synced.stderr.slice(0, 400));
  assert.equal(await readCheckCache(root), null);
  const line = await runCli(['status', '--line', '--root', root], env);
  assert.equal(line.stdout.trim(), 'simt no cache - run check');
});
