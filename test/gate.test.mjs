// Diff-aware gates (R16, ADR-094).
//
// A change selects the test files that import it, directly or through other
// files. The list below was read off the import specifiers in this checkout.
// It is not the output of the function under test. A helper under test/ is on
// it when that helper imports the change: the shared fixture imports the graph
// loader, and the loader imports the resolver, so the closure is wide.

import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { test } from 'node:test';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

import { gateCommand } from '../src/commands/gate.mjs';
import { readImportEdges, selectTests } from '../src/index/gate.mjs';

const exec = promisify(execFile);
const ROOT = new URL('..', import.meta.url).pathname;

const RESOLVE = [
  // advice reaches the resolver only since R40: its loadHistory tests import the
  // shared fixture, and the fixture loads the registry, so the closure widened.
  'test/advice.test.mjs',
  'test/agenthooks.test.mjs',
  'test/baselines.test.mjs',
  'test/bench.test.mjs',
  'test/brief.test.mjs',
  'test/card.test.mjs',
  'test/checks.test.mjs',
  'test/ci.test.mjs',
  'test/compare.test.mjs',
  'test/compile.test.mjs',
  'test/contract.test.mjs',
  'test/decide.test.mjs',
  // distill reaches the resolver only since R39: its --local guard goes through
  // local/config.mjs, which resolves the manifest, so the closure widened.
  'test/disclosure.test.mjs',
  'test/distill.test.mjs',
  'test/eval.test.mjs',
  'test/extract.test.mjs',
  'test/federation.test.mjs',
  'test/fixture.mjs',
  'test/genericity.test.mjs',
  'test/graph.test.mjs',
  'test/help.test.mjs',
  'test/hooks.test.mjs',
  'test/identity.test.mjs',
  'test/index.test.mjs',
  'test/inferability.test.mjs',
  'test/init.test.mjs',
  'test/install.test.mjs',
  'test/jsoncontract.test.mjs',
  'test/kernel.test.mjs',
  'test/leaks.mjs',
  'test/ledger.test.mjs',
  'test/loaders.test.mjs',
  'test/lock.test.mjs',
  'test/map.test.mjs',
  'test/mapping.test.mjs',
  'test/markers.test.mjs',
  'test/mcp.test.mjs',
  'test/mdc.test.mjs',
  'test/monorepo.test.mjs',
  'test/naming.test.mjs',
  'test/pack.test.mjs',
  'test/packs.test.mjs',
  'test/plan.test.mjs',
  'test/project.test.mjs',
  'test/resolve.test.mjs',
  'test/rules.test.mjs',
  'test/scoped.test.mjs',
  'test/shared.test.mjs',
  'test/shipped.test.mjs',
  'test/surfaces.test.mjs',
  'test/tokens.test.mjs',
  'test/toolchain.test.mjs',
  'test/tsconfig.test.mjs',
  'test/unit.test.mjs',
  'test/upgrade.test.mjs',
  'test/variants.test.mjs',
  'test/why-fixture.test.mjs',
  'test/why-snapshot.test.mjs',
  'test/workspace.test.mjs',
];

test('changing the resolver selects the tests that import it, in under five seconds', async () => {
  const { stdout } = await exec('git', ['ls-files'], { cwd: ROOT, maxBuffer: 16 << 20 });
  const files = stdout.split('\n').filter(Boolean);
  const started = performance.now();
  const selected = selectTests(['src/resolve/resolve.mjs'], await readImportEdges(ROOT, files));
  const elapsed = performance.now() - started;
  assert.deepEqual(selected, RESOLVE);
  assert.ok(elapsed < 5000, `selection took ${elapsed.toFixed(0)} ms`);
});

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
