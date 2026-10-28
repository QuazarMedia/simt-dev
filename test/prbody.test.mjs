// R55: `simt pr-body` — the pull request body from the ledger, the diff and
// the last check.
//
// The slice's acceptance is a snapshot of a fixture PR: a repository with a
// base commit, a second commit touching a file and a decision record, and a
// ledger run recorded against the resulting tree. The body must carry all four
// sections — evidence, changed decisions, gates, residual risk — with the
// ADR-008 verdict the state earns, and the JSON must be one compact document.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { git } from './fixture.mjs';
import { recordRun } from '../src/ledger/index.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const BIN = resolve(HERE, '..', 'bin', 'simt.mjs');
const exec = promisify(execFile);

async function run(args, { cwd } = {}) {
  try {
    const { stdout, stderr } = await exec('node', [BIN, ...args], {
      cwd,
      maxBuffer: 32 << 20,
      env: { ...process.env, NO_COLOR: '1', SIMT_DEV_WORKSPACE: 'off' },
    });
    return { code: 0, stdout, stderr };
  } catch (error) {
    return { code: error.code ?? 1, stdout: error.stdout ?? '', stderr: error.stderr ?? '' };
  }
}

/**
 * A two-commit fixture PR: a base commit, then a commit touching a source
 * file and a decision record. The base is named explicitly so the body never
 * depends on which branch names the runner happens to carry.
 */
async function fixturePr() {
  const root = await mkdtemp(join(tmpdir(), 'simt-prbody-'));
  await git(['init', '-q', '-b', 'main', '.'], { cwd: root });
  await writeFile(join(root, 'app.mjs'), 'export const a = 1;\n');
  await git(['add', '-A'], { cwd: root });
  await git(['commit', '-qm', 'base'], { cwd: root });
  const base = (await git(['rev-parse', 'HEAD'], { cwd: root })).stdout.trim();
  await writeFile(join(root, 'app.mjs'), 'export const a = 2;\n');
  await mkdir(join(root, 'docs', 'decisions'), { recursive: true });
  await writeFile(
    join(root, 'docs', 'decisions', 'ADR-999-example.md'),
    '---\nsimt-affects: []\nsimt-supersedes: []\n---\n\n# ADR-999 — Example ruling\n\nStatus: **accepted** · 2026-10-27\n\n## Context\n\nA fixture.\n',
  );
  await git(['add', '-A'], { cwd: root });
  await git(['commit', '-qm', 'change'], { cwd: root });
  return { root, base };
}

test('pr-body snapshots the fixture PR: evidence, decisions, gates, residual risk', async (t) => {
  const { root, base } = await fixturePr();
  t.after(() => rm(root, { recursive: true, force: true }));

  await recordRun(root, { cmd: 'node --test', exit: 0, ms: 12, output: '1 pass, 0 fail\n' });

  const out = await run(['pr-body', '--base', base, '--root', root], { cwd: root });
  assert.equal(out.code, 0, out.stderr);
  const sections = [...out.stdout.matchAll(/^## (.+)$/gm)].map((m) => m[1]);
  assert.deepEqual(sections, ['Evidence', 'Changed decisions', 'Gates', 'Residual risk (ADR-008)']);
  assert.match(out.stdout, /pass `node --test` \(exit 0, 1 pass, 0 fail\)/);
  assert.match(out.stdout, /ADR-999 — Example ruling /);
  assert.match(out.stdout, /accepted/);
  assert.match(out.stdout, /No check has run: gate state unmeasured\./);
  assert.match(out.stdout, /Verdict: APPROVE WITH RESIDUAL RISK/);
  assert.match(out.stdout, /gate state unmeasured \(no check has run\)/);
});

test('pr-body with a passing run and a check on record approves', async (t) => {
  const { root, base } = await fixturePr();
  t.after(() => rm(root, { recursive: true, force: true }));

  // A passing check on record, seeded directly: running `check` on a bare
  // fixture would judge the missing baselines, which is not this slice.
  // The cache lands before the ledger run so both name the same tree.
  const { buildCacheRecord, writeCheckCache } = await import('../src/status.mjs');
  await writeCheckCache(
    root,
    await buildCacheRecord(root, { rulesOk: true, hooksOk: true, gatesRun: 2, gatesTotal: 2, blocking: 0, warnings: 0 }),
  );
  await recordRun(root, { cmd: 'node --test', exit: 0, ms: 12, output: '1 pass, 0 fail\n' });

  const out = await run(['pr-body', '--base', base, '--root', root], { cwd: root });
  assert.equal(out.code, 0, out.stderr);
  assert.match(out.stdout, /Verdict: APPROVE\n/);
  assert.doesNotMatch(out.stdout, /Not reviewed:/);
});

test('pr-body with no run recorded names what was not reviewed', async (t) => {
  const { root, base } = await fixturePr();
  t.after(() => rm(root, { recursive: true, force: true }));

  const out = await run(['pr-body', '--base', base, '--root', root], { cwd: root });
  assert.equal(out.code, 0, out.stderr);
  assert.match(out.stdout, /No run is recorded for this tree\./);
  assert.match(out.stdout, /Verdict: APPROVE WITH RESIDUAL RISK/);
  assert.match(out.stdout, /no passing run is recorded for this tree/);
});

test('pr-body refuses an unknown base without touching the tree', async (t) => {
  const { root } = await fixturePr();
  t.after(() => rm(root, { recursive: true, force: true }));

  const before = (await git(['status', '--porcelain'], { cwd: root })).stdout;
  const out = await run(['pr-body', '--base', 'no-such-ref', '--root', root], { cwd: root });
  assert.equal(out.code, 2, out.stdout);
  assert.match(`${out.stdout}${out.stderr}`, /unknown base no-such-ref/);
  assert.equal((await git(['status', '--porcelain'], { cwd: root })).stdout, before);
});

test('pr-body --json is one compact document with the verdict', async (t) => {
  const { root, base } = await fixturePr();
  t.after(() => rm(root, { recursive: true, force: true }));

  await recordRun(root, { cmd: 'node --test', exit: 0, ms: 12, output: '1 pass, 0 fail\n' });

  const out = await run(['pr-body', '--base', base, '--root', root, '--json'], { cwd: root });
  assert.equal(out.code, 0, out.stderr);
  assert.equal(out.stdout.trim().split('\n').length, 1, 'the JSON must stay one line for piped readers');
  const payload = JSON.parse(out.stdout);
  assert.equal(payload.ok, true);
  assert.equal(payload.command, 'pr-body');
  assert.equal(payload.base, base);
  assert.equal(payload.verdict, 'APPROVE WITH RESIDUAL RISK');
  assert.deepEqual(
    payload.decisions.map((d) => d.id),
    ['ADR-999'],
  );
  assert.ok(Array.isArray(payload.paths) && payload.paths.includes('app.mjs'));
  assert.ok(payload.schemaVersion >= 1, 'the document carries the version a rename would need');
});
