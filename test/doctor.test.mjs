// `simt doctor --fix` (plan 0003 R47): remedies flagged safe are applied,
// the rest are listed with the reason each needs a human.
//
// The acceptance is a fixture with 3 safe and 2 unsafe findings where --fix
// fixes exactly the 3 safe ones: a stale manifest pin, uninstalled hooks and
// an unignored journal are local, idempotent and journaled; a broken workspace
// config and a missing shared copy are not. The unsafe set is untouchable under
// every flag combination, and the preview writes nothing.

import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

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
  const root = await mkdtemp(join(tmpdir(), 'simt-doctor-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await git(['init', '-q'], { cwd: root });
  return root;
}

async function scratchDir(t) {
  const dir = await mkdtemp(join(tmpdir(), 'simt-doctor-home-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

/**
 * A repo with exactly 3 safe findings (stale pin, missing shims, unignored
 * journal) and 2 unsafe ones (broken workspace config, absent shared copy).
 * HOME points at scratch so the shared copy is deterministically absent;
 * XDG_CONFIG_HOME holds a config that does not parse.
 */
async function fiveFindingFixture(t) {
  const root = await freshRoot(t);
  const home = await scratchDir(t);
  const xdg = await scratchDir(t);
  await writeFile(join(root, 'package.json'), '{"name":"clinic","scripts":{"test":"exit 0"}}\n', 'utf8');

  const setupEnv = { HOME: home, SIMT_DEV_WORKSPACE: 'off' };
  const init = await runCli(['init', '--root', root, '--yes'], setupEnv);
  assert.equal(init.code, 0, init.stderr.slice(0, 500));

  // Stale the pin, declare a gate (so shims are owed) and declare shared rules
  // (so the absent copy is a finding). Gates and shared are chosen keys, so the
  // only drift is the pin itself: still one finding, not three.
  const manifestPath = join(root, 'simt.json');
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  manifest.projection.simtDevSha = '0'.repeat(40);
  manifest.gates = { ...(manifest.gates ?? {}), preCommit: ['test'], prePush: [] };
  manifest.shared = { level: 'user', rules: ['core'] };
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');

  // A real journal set (via decide), then strip the ignore entry so the
  // journal exists but is unignored.
  const decided = await runCli(['decide', 'Fix me', '--root', root, '--yes'], setupEnv);
  assert.equal(decided.code, 0, decided.stderr.slice(0, 500));
  const ignorePath = join(root, '.gitignore');
  const kept = (await readFile(ignorePath, 'utf8'))
    .split('\n')
    .filter((l) => !l.includes('journal') && !l.includes('.simt/local') && !l.includes('Write journal for'))
    .join('\n');
  await writeFile(ignorePath, kept, 'utf8');

  await mkdir(join(xdg, 'simt-dev'), { recursive: true });
  await writeFile(join(xdg, 'simt-dev', 'config.json'), '{', 'utf8');
  const env = { HOME: home, XDG_CONFIG_HOME: xdg, SIMT_DEV_WORKSPACE: 'off' };
  return { root, env };
}

function findingIds(payload) {
  return new Set(payload.findings.map((f) => f.id));
}

test('R47: the fixture reports 3 safe and 2 unsafe findings', async (t) => {
  const { root, env } = await fiveFindingFixture(t);
  const { code, stdout } = await runCli(['doctor', '--root', root, '--json'], env);
  // Exit 3, not 0: the broken workspace config is severity error (as before
  // R47), so the run still fails while the warnings are only reported.
  assert.equal(code, 3, stdout.slice(0, 500));
  const payload = JSON.parse(stdout);
  assert.equal(payload.ok, false);
  assert.deepEqual(findingIds(payload), new Set(['manifest-stale', 'hooks-incomplete', 'journal-unignored', 'shared-copy', 'workspace-config']));
  const safe = new Set(payload.findings.filter((f) => f.safe).map((f) => f.id));
  assert.deepEqual(safe, new Set(['manifest-stale', 'hooks-incomplete', 'journal-unignored']));
  for (const finding of payload.findings) {
    if (!finding.safe) assert.ok(finding.why, `${finding.id} is listed with the reason it needs a human`);
  }
});

test('R47: --fix previews without writing', async (t) => {
  const { root, env } = await fiveFindingFixture(t);
  const before = JSON.parse(await readFile(join(root, 'simt.json'), 'utf8'));
  const preview = await runCli(['doctor', '--fix', '--root', root, '--json'], env);
  assert.equal(preview.code, 3, preview.stdout.slice(0, 500));
  const payload = JSON.parse(preview.stdout);
  assert.equal(payload.fix.requested, true);
  assert.equal(payload.fix.applied, false);
  assert.deepEqual(new Set(payload.fix.fixed), new Set());
  // Nothing changed: the pin is still stale, no shims, no ignore entry.
  const after = JSON.parse(await readFile(join(root, 'simt.json'), 'utf8'));
  assert.equal(after.projection.simtDevSha, before.projection.simtDevSha);
  await assert.rejects(readFile(join(root, '.simt-hooks', 'pre-commit')), 'preview installs no shims');
});

test('R47: --fix --yes fixes exactly the 3 safe findings, journaled', async (t) => {
  const { root, env } = await fiveFindingFixture(t);
  const fixed = await runCli(['doctor', '--fix', '--yes', '--root', root, '--json'], env);
  assert.equal(fixed.code, 3, fixed.stderr.slice(0, 500) + fixed.stdout.slice(0, 500));
  const payload = JSON.parse(fixed.stdout);
  assert.equal(payload.ok, false);
  assert.deepEqual(new Set(payload.fix.fixed), new Set(['manifest-stale', 'hooks-incomplete', 'journal-unignored']));
  assert.deepEqual(payload.fix.failed, []);

  // On disk: the pin is current, the shim is installed, the journal ignored.
  const manifest = JSON.parse(await readFile(join(root, 'simt.json'), 'utf8'));
  assert.notEqual(manifest.projection.simtDevSha, '0'.repeat(40));
  await readFile(join(root, '.simt-hooks', 'pre-commit'));
  const ignore = await readFile(join(root, '.gitignore'), 'utf8');
  assert.match(ignore, /\.simt\/local\//);

  // A second run sees only the 2 unsafe findings: the safe set is gone.
  const again = await runCli(['doctor', '--root', root, '--json'], env);
  assert.equal(again.code, 3);
  assert.deepEqual(findingIds(JSON.parse(again.stdout)), new Set(['shared-copy', 'workspace-config']));

  // Journaled means undoable: the fix set restores all three repairs at once.
  const undone = await runCli(['undo', '--yes', '--root', root, '--json'], env);
  assert.equal(undone.code, 0, undone.stderr.slice(0, 500));
  const restored = JSON.parse(await readFile(join(root, 'simt.json'), 'utf8'));
  assert.equal(restored.projection.simtDevSha, '0'.repeat(40));
  await assert.rejects(readFile(join(root, '.simt-hooks', 'pre-commit')), 'undo removes the installed shim');
});

test('R47: unsafe findings are listed under every flag combination, never applied', async (t) => {
  const { root, env } = await fiveFindingFixture(t);
  const preview = await runCli(['doctor', '--fix', '--root', root], env);
  assert.equal(preview.code, 3, preview.stderr.slice(0, 500));
  assert.match(preview.stdout, /finding {2}shared-copy/);
  assert.match(preview.stdout, /manual: not applied by --fix/);
  assert.match(preview.stdout, /finding {2}workspace-config/);
});

test('R47: a missing manifest is listed, never adopted', async (t) => {
  const root = await freshRoot(t);
  await writeFile(join(root, 'package.json'), '{"name":"bare"}\n', 'utf8');
  const env = { HOME: await scratchDir(t), SIMT_DEV_WORKSPACE: 'off' };
  const report = await runCli(['doctor', '--root', root, '--json'], env);
  assert.equal(report.code, 0);
  const ids = findingIds(JSON.parse(report.stdout));
  assert.ok(ids.has('manifest-absent'));

  const fixed = await runCli(['doctor', '--fix', '--yes', '--root', root, '--json'], env);
  assert.equal(fixed.code, 0, fixed.stderr.slice(0, 500));
  assert.deepEqual(JSON.parse(fixed.stdout).fix.fixed, []);
  await assert.rejects(readFile(join(root, 'simt.json')), '--fix does not adopt the repo');
});

test('R47: hooks routed elsewhere are a takeover finding, never taken over', async (t) => {
  const root = await freshRoot(t);
  const home = await scratchDir(t);
  const env = { HOME: home, SIMT_DEV_WORKSPACE: 'off' };
  await writeFile(join(root, 'package.json'), '{"name":"taken"}\n', 'utf8');
  assert.equal((await runCli(['init', '--root', root, '--yes'], env)).code, 0);
  const manifestPath = join(root, 'simt.json');
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  manifest.gates = { ...(manifest.gates ?? {}), preCommit: ['test'], prePush: [] };
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
  // A live hand-written hook git actually runs: foreign means executable, and a
  // 644 file is a sample, not a hook. Without the bit this stages an install.
  const hookPath = join(root, '.git', 'hooks', 'pre-commit');
  await writeFile(hookPath, '#!/bin/sh\nexit 0\n', 'utf8');
  await chmod(hookPath, 0o755);

  const report = await runCli(['doctor', '--root', root, '--json'], env);
  assert.equal(report.code, 0, report.stdout.slice(0, 500));
  const payload = JSON.parse(report.stdout);
  assert.ok(findingIds(payload).has('hooks-takeover'), JSON.stringify(payload.findings.map((f) => f.id)));
  assert.ok(!findingIds(payload).has('hooks-incomplete'), 'a takeover is not also an install');

  const fixed = await runCli(['doctor', '--fix', '--yes', '--root', root, '--json'], env);
  assert.equal(fixed.code, 0);
  assert.deepEqual(JSON.parse(fixed.stdout).fix.fixed, []);
  await assert.rejects(
    readFile(join(root, '.simt-hooks', 'pre-commit')),
    '--fix leaves foreign-routed hooks alone',
  );
});

test('R47: an unreadable manifest is listed and left alone', async (t) => {
  const root = await freshRoot(t);
  const env = { HOME: await scratchDir(t), SIMT_DEV_WORKSPACE: 'off' };
  await writeFile(join(root, 'simt.json'), '{nope', 'utf8');
  const before = await readFile(join(root, 'simt.json'), 'utf8');
  const report = await runCli(['doctor', '--root', root, '--json'], env);
  assert.equal(report.code, 0, report.stdout.slice(0, 500));
  assert.ok(findingIds(JSON.parse(report.stdout)).has('manifest-unreadable'));
  const fixed = await runCli(['doctor', '--fix', '--yes', '--root', root, '--json'], env);
  assert.equal(fixed.code, 0);
  assert.equal(await readFile(join(root, 'simt.json'), 'utf8'), before);
});
