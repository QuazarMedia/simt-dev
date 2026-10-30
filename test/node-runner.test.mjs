// The one Node runner resolver (review 0003 Q31).
//
// Before it, four tables answered "how does this repo run a script" and
// disagreed: the card printed `npm run` in a pnpm checkout, the dispatcher
// spawned `npm run`, and CI installed with `npm ci`. One data table, one
// resolver, every consumer.

import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import {
  NODE_MANAGERS,
  installCommands,
  isNodeRunner,
  lookupNodeManager as lookupNodeRunner,
  managerFromPackageField,
  npmManager,
  resolveNodeRunner,
  runScript,
  runScriptArgv,
} from '../src/ecosystem/node-runner.mjs';

async function scratch(files = {}) {
  const root = await mkdtemp(join(tmpdir(), 'simt-runner-'));
  for (const [name, body] of Object.entries(files)) {
    await writeFile(join(root, name), body);
  }
  return root;
}

test('lockfile wins over the packageManager field', () => {
  const runner = resolveNodeRunner({ lockfiles: ['pnpm-lock.yaml'], packageManager: 'npm@10.9.1' });
  assert.equal(runner.id, 'pnpm');
});

test('the declared field wins over the npm default with no lockfile', () => {
  assert.equal(resolveNodeRunner({ packageManager: 'pnpm@9.12.0' }).id, 'pnpm');
  assert.equal(resolveNodeRunner({ packageManager: 'yarn@1.22.22' }).id, 'yarn');
  assert.equal(resolveNodeRunner({ packageManager: 'bun@1.2.0' }).id, 'bun');
  assert.equal(resolveNodeRunner({}).id, 'npm');
});

test('facts resolve the same way lockfiles do', () => {
  assert.equal(resolveNodeRunner({ facts: ['has-yarn-lock'] }).id, 'yarn');
  assert.equal(resolveNodeRunner({ facts: new Set(['has-bun-lock']) }).id, 'bun');
  assert.equal(resolveNodeRunner({ facts: ['has-package-lock'] }).id, 'npm');
});

test('an unknown manager is null, never a guess', () => {
  assert.equal(managerFromPackageField('flake@1.0.0'), null);
  assert.equal(managerFromPackageField(null), null);
  assert.equal(managerFromPackageField(42), null);
  assert.equal(resolveNodeRunner({ packageManager: 'flake@1.0.0' }).id, 'npm');
});

test('every manager spells run, argv and install from its own row', () => {
  assert.equal(runScript('pnpm', 'lint'), 'pnpm run lint');
  assert.equal(runScript('yarn', 'test'), 'yarn run test');
  assert.deepEqual(runScriptArgv('npm', 'test'), ['npm', 'run', '--silent', 'test']);
  assert.deepEqual(runScriptArgv('pnpm', 'test'), ['pnpm', 'run', '--silent', 'test']);
  // bun has no silent flag; the shape is still `<manager> run <script>`.
  assert.deepEqual(runScriptArgv('bun', 'test'), ['bun', 'run', 'test']);
  assert.equal(installCommands('pnpm').install, 'pnpm install --frozen-lockfile');
  assert.equal(installCommands('yarn').fallback, 'yarn install');
  assert.equal(installCommands('bun').setupNode, false);
  assert.equal(installCommands('npm').setupNode, true);
  assert.equal(npmManager().id, 'npm');
});

test('isNodeRunner and lookupNodeRunner read the same table', () => {
  for (const row of NODE_MANAGERS) {
    assert.ok(isNodeRunner(row.id), `${row.id} is a Node runner`);
    assert.equal(lookupNodeRunner({ id: row.id }).id, row.id);
  }
  assert.ok(!isNodeRunner('gradle'), 'Gradle is not a Node runner');
  assert.ok(!isNodeRunner(undefined), 'an unreported runner is not a Node runner');
  assert.equal(lookupNodeRunner({ fact: 'has-pnpm-lock' }).id, 'pnpm');
  assert.equal(lookupNodeRunner({ lockfile: 'yarn.lock' }).id, 'yarn');
  assert.equal(lookupNodeRunner({}), null);
});

test('fingerprint emits one fact per Node lockfile', async () => {
  const { fingerprint } = await import('../src/resolve/fingerprint.mjs');
  const pnpm = await fingerprint(await scratch({ 'package.json': '{}', 'pnpm-lock.yaml': '' }));
  assert.ok(pnpm.facts.includes('has-pnpm-lock'), 'pnpm lockfile emits its fact');
  const yarn = await fingerprint(await scratch({ 'package.json': '{}', 'yarn.lock': '' }));
  assert.ok(yarn.facts.includes('has-yarn-lock'), 'yarn lockfile emits its fact');
  const npm = await fingerprint(await scratch({ 'package.json': '{}', 'package-lock.json': '' }));
  assert.ok(npm.facts.includes('has-package-lock'), 'npm lockfile emits its fact');
});

test('the card names the repo manager, not a bare npm', async () => {
  const { commandCard } = await import('../src/kernel/card.mjs');
  const root = await scratch({
    'package.json': JSON.stringify({
      name: 'x',
      packageManager: 'pnpm@9.12.0',
      scripts: { test: 'vitest run', lint: 'eslint .' },
    }),
    'pnpm-lock.yaml': '',
  });
  const { fingerprint } = await import('../src/resolve/fingerprint.mjs');
  const { stack, facts } = await fingerprint(root);
  const card = await commandCard({ root, stack, facts });
  const byLabel = new Map(card.lines.map((l) => [l.label, l.command]));
  assert.equal(byLabel.get('test'), 'pnpm run test');
  assert.equal(byLabel.get('lint'), 'pnpm run lint');
});

test('gateRunnable and the remedy spell the repo manager', async () => {
  const gateModule = await import('../src/projection/manifest.mjs');
  const { getGate } = await import('../src/hooks/gates.mjs');
  const verdict = gateModule.gateRunnable(getGate('test'), {
    scripts: { test: 'vitest run' },
    binaries: [],
    commands: {},
    runner: 'pnpm',
  });
  assert.ok(verdict.runnable, 'a pnpm repo with a test script runs its test gate');
  assert.match(verdict.why, /pnpm run test/);
  const dropped = gateModule.planGates(['node'], {
    scripts: {},
    binaries: [],
    commands: {},
    runner: 'pnpm',
  }).dropped;
  const format = dropped.find((d) => d.gate === 'format');
  assert.match(format.remedy, /pnpm add -D/, 'the remedy installs with the repo manager');
});

test('the dispatcher spawns the repo manager for script gates', async () => {
  const { resolveGate } = await import('../src/hooks/resolve.mjs');
  const { getGate } = await import('../src/hooks/gates.mjs');
  const pnpm = await resolveGate(getGate('test'), {
    root: '/x',
    pkg: { scripts: { test: 'vitest run' }, packageManager: 'pnpm@9.12.0' },
    staged: [],
    commands: {},
  });
  assert.ok(pnpm.ok, 'the gate resolves');
  assert.deepEqual(pnpm.argv, ['pnpm', 'run', '--silent', 'test']);
  assert.match(pnpm.detail, /pnpm run test/);
  const npm = await resolveGate(getGate('test'), {
    root: '/x',
    pkg: { scripts: { test: 'vitest run' } },
    staged: [],
    commands: {},
  });
  assert.deepEqual(npm.argv, ['npm', 'run', '--silent', 'test']);
});

test('the workflow installs with the repo manager', async () => {
  const { renderWorkflow } = await import('../src/ci/workflow.mjs');
  const pnpm = renderWorkflow({ manager: 'pnpm', version: '0.6.2' });
  assert.match(pnpm, /pnpm install --frozen-lockfile/, 'the frozen install names pnpm');
  assert.match(pnpm, /pnpm add -D/, 'the remedy names pnpm');
  assert.ok(!/npm ci/.test(pnpm), 'no npm install step leaks into a pnpm workflow');
  const npm = renderWorkflow({ version: '0.6.2' });
  assert.match(npm, /npm ci \|\| npm install/, 'the npm default keeps its bytes');
  const binary = renderWorkflow({ npm: false, version: '0.6.2' });
  assert.match(binary, /install the pinned gate binary/, 'the non-Node branch keeps its bytes');
});
