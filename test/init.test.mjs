import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import * as gateModule from '../src/projection/manifest.mjs';
import * as gateTable from '../src/hooks/gates.mjs';
import { readCapability, declaredCommands } from '../src/hooks/capability.mjs';

const buildManifest = gateModule.buildManifest;

async function capture(run) {
  const chunks = [];
  const real = process.stdout.write.bind(process.stdout);
  process.stdout.write = (c) => { chunks.push(String(c)); return true; };
  let code;
  try {
    code = await run();
  } finally {
    process.stdout.write = real;
  }
  return { code, text: chunks.join('') };
}

async function scratch() {
  return mkdtemp(join(tmpdir(), 'simt-manifest-'));
}

test('manifest: id defaults to the directory name', async () => {
  const root = await scratch();
  const { id } = buildManifest({ root, stack: ['python'] });
  assert.equal(id, root.split('/').pop());
});

test('manifest: coverage is null by default, not a guessed number (ADR-006)', () => {
  // The central rule mandates evidence discipline; the numeric bar is declared.
  // Inventing a default here would be worse than declaring none, because a
  // fabricated number reads as a decision the repo never made.
  const { limits } = buildManifest({ root: '/x/y', stack: ['python'] });
  assert.equal(limits.coverage, null);
});

test('manifest: file length defaults to the ADR-005 two tiers', () => {
  const { limits } = buildManifest({ root: '/x/y', stack: ['node'] });
  assert.deepEqual(limits.fileLines, { warn: 400, error: 1000 });
});

test('manifest: an existing manifest is never weakened by a re-init', () => {
  const existing = {
    id: 'custom-id',
    stack: ['python'],
    limits: { coverage: 100, fileLines: { warn: 250, error: 600 } },
    gates: { preCommit: ['ruff'], prePush: ['pytest'] },
    localSkills: ['coverage-hunt'],
    substitutions: { 'test-gate': { plansGlob: '../simt-social/docs/plans/*' } },
  };
  const next = buildManifest({ root: '/x/y', stack: ['gradle'], sha: 'abc1234', existing });
  assert.equal(next.id, 'custom-id');
  assert.equal(next.limits.coverage, 100);
  assert.deepEqual(next.limits.fileLines, { warn: 250, error: 600 });
  assert.deepEqual(next.gates.preCommit, ['ruff']);
  assert.deepEqual(next.localSkills, ['coverage-hunt']);
  // ADR-016: the repo's own substitution values survive a re-init. Losing them would
  // reset every generated `.mdc` rule to its defaults, which is a silent edit of four
  // files nobody asked to change.
  assert.deepEqual(next.substitutions['test-gate'], {
    plansGlob: '../simt-social/docs/plans/*',
  });
  // The declared stack wins over detection, or a re-init would silently reclassify.
  assert.deepEqual(next.stack, ['python']);
  // Only the projection stamp is refreshed.
  assert.equal(next.projection.simtDevSha, 'abc1234');
});

test('manifest: substitutions are seeded, not absent (ADR-016)', () => {
  // An absent key looks like an oversight; an empty object says the shape exists and
  // nothing needs filling in yet.
  const { substitutions } = buildManifest({ root: '/x/y', stack: ['node'] });
  assert.deepEqual(substitutions, {});
});

test('manifest: connectiq gets memory and codegen-drift gates (ADR-006)', () => {
  const { gates } = buildManifest({ root: '/x/y', stack: ['connectiq'] });
  assert.ok(gates.preCommit.includes('memory'));
  assert.ok(gates.preCommit.includes('codegen-drift'));
});

test('manifest: an unrecognised stack still gets a gate list', () => {
  // A gate that runs nothing is indistinguishable from a gate never installed.
  const { gates } = buildManifest({ root: '/x/y', stack: [] });
  assert.ok(gates.preCommit.length > 0);
  assert.ok(gates.prePush.length > 0);
});

test('manifest: typescript repos get typecheck on pre-push', () => {
  const { gates } = buildManifest({ root: '/x/y', stack: ['typescript', 'node'] });
  assert.ok(gates.prePush.includes('typecheck'));
});

test('init: dry-run is the default and writes nothing', async () => {
  const { initCommand } = await import('../src/commands/init.mjs');
  const root = await scratch();
  await writeFile(join(root, 'monkey.jungle'), '');
  const code = await initCommand([], { root, yes: false });
  assert.equal(code, 0);
  // No manifest, because nothing was applied.
  await assert.rejects(readFile(join(root, 'simt-dev.json'), 'utf8'));
});

test('init: a conflicting repo is blocked before any write', async () => {
  const { initCommand } = await import('../src/commands/init.mjs');
  const root = await scratch();
  await writeFile(join(root, 'monkey.jungle'), '');
  await writeFile(join(root, 'AGENTS.md'), '# Rules\n\n8. Committed and pushed with a conventional message\n');
  const code = await initCommand([], { root, yes: true });
  assert.equal(code, 1, 'a conflict must block even with --yes');
  await assert.rejects(readFile(join(root, 'simt-dev.json'), 'utf8'));
});

test('init: --accept-conflicts proceeds and writes both files', async () => {
  const { initCommand } = await import('../src/commands/init.mjs');
  const root = await scratch();
  await writeFile(join(root, 'monkey.jungle'), '');
  const agents = '# Rules\n\n1. Committed and pushed with a conventional message\n';
  await writeFile(join(root, 'AGENTS.md'), agents);
  const code = await initCommand([], { root, yes: true, acceptConflicts: true });
  assert.equal(code, 0);
  const manifest = JSON.parse(await readFile(join(root, 'simt-dev.json'), 'utf8'));
  assert.ok(manifest.projection.simtDevSha);
  const after = await readFile(join(root, 'AGENTS.md'), 'utf8');
  // The hand-written line survives verbatim: init never overwrites prose.
  assert.ok(after.startsWith(agents.trimEnd()));
  assert.ok(after.includes('simt-dev:begin'));
});

test('init: a malformed region blocks rather than duplicating the rules', async () => {
  const { initCommand } = await import('../src/commands/init.mjs');
  const root = await scratch();
  await writeFile(join(root, 'monkey.jungle'), '');
  await writeFile(join(root, 'AGENTS.md'), '# R\n\n<!-- simt-dev:begin -->\nstuff\n');
  const code = await initCommand([], { root, yes: true });
  assert.equal(code, 1);
  const after = await readFile(join(root, 'AGENTS.md'), 'utf8');
  assert.equal(after.match(/simt-dev:begin/g).length, 1, 'must not append a second region');
});

test('init: scaffolding a repo with no rules creates AGENTS.md', async () => {
  const { initCommand } = await import('../src/commands/init.mjs');
  const root = await scratch();
  await writeFile(join(root, 'monkey.jungle'), '');
  const code = await initCommand([], { root, yes: true });
  assert.equal(code, 0);
  const after = await readFile(join(root, 'AGENTS.md'), 'utf8');
  assert.ok(after.includes('simt-dev:begin'));
  assert.ok(after.includes('simt-dev:end'));
});

test('init: never commits', async () => {
  // ADR-001. init writes files; a human decides whether that becomes a commit.
  const { initCommand } = await import('../src/commands/init.mjs');
  const { execFile } = await import('node:child_process');
  const { promisify } = await import('node:util');
  const run = promisify(execFile);

  const root = await scratch();
  await run('git', ['init', '-q'], { cwd: root });
  await writeFile(join(root, 'monkey.jungle'), '');
  await run('git', ['add', '-A'], { cwd: root });
  await run('git', ['-c', 'user.email=t@e.st', '-c', 'user.name=T', 'commit', '-qm', 'base'], {
    cwd: root,
  });

  await initCommand([], { root, yes: true });

  const { stdout: log } = await run('git', ['log', '--oneline'], { cwd: root });
  assert.equal(log.trim().split('\n').length, 1, 'init must not create a commit');
  const { stdout } = await run('git', ['status', '--porcelain'], { cwd: root });
  assert.match(stdout, /simt-dev\.json/, 'files are left uncommitted for review');
});

test('init: a repo with no commits is still adoptable', async () => {
  // An unborn repo cannot be tagged, so the escape hatch degrades to a note
  // rather than blocking. Refusing to initialise would be worse.
  const { initCommand } = await import('../src/commands/init.mjs');
  const { execFile } = await import('node:child_process');
  const { promisify } = await import('node:util');
  const run = promisify(execFile);

  const root = await scratch();
  await run('git', ['init', '-q'], { cwd: root });
  await writeFile(join(root, 'monkey.jungle'), '');

  assert.equal(await initCommand([], { root, yes: true }), 0);
  const manifest = await readFile(join(root, 'simt-dev.json'), 'utf8');
  assert.match(manifest, /simtDevSha/);
});
test('manifest: the default id is the repo name, not unnamed-repo (ADR-016 follow-up)', () => {
  // `basename('.')` is `''`, so the most natural invocation — `simt-dev init .` — wrote an
  // `unnamed-repo` id into the one field of the manifest a human reads.
  assert.equal(buildManifest({ root: '.', stack: [] }).id, process.cwd().split('/').pop());
  assert.equal(buildManifest({ root: process.cwd(), stack: [] }).id, process.cwd().split('/').pop());
});

// ---------------------------------------------------------------------------
// Gate runnability. A declared gate this repo cannot run fails closed on every
// commit once hooks are installed, so the only exit an author finds is
// `--no-verify`. init must not write one, and check must report one that a
// hand-edited or older manifest still carries.
// ---------------------------------------------------------------------------

test('gate: a staged gate needs its formatter INSTALLED, not merely declared', () => {
  const { gateRunnable } = gateModule;
  const format = gateTable.getGate('format');
  assert.equal(gateTable.GATES.format.kind, 'staged');
  assert.deepEqual(gateTable.GATES.format.tools, ['prettier']);
  assert.equal(gateRunnable(format, { binaries: [] }).runnable, false);
  assert.match(gateRunnable(format, { binaries: [] }).why, /prettier is not installed/);
  assert.equal(gateRunnable(format, { binaries: ['prettier'] }).runnable, true);
});

test('gate: a script gate needs the script to exist in package.json', () => {
  const { gateRunnable } = gateModule;
  const test_ = gateTable.getGate('test');
  assert.equal(gateRunnable(test_, { scripts: {} }).runnable, false);
  assert.equal(gateRunnable(test_, { scripts: { test: 'vitest run' } }).runnable, true);
  // coverage names a script that is NOT the gate name; getting that wrong declares
  // a coverage gate that silently runs the plain test suite instead.
  assert.equal(gateTable.GATES.coverage.script, 'test:coverage');
  assert.equal(gateRunnable(gateTable.getGate('coverage'), { scripts: { test: 'x' } }).runnable, false);
  assert.equal(
    gateRunnable(gateTable.getGate('coverage'), { scripts: { 'test:coverage': 'x' } }).runnable,
    true,
  );
});

test('gate: a command gate is unrunnable unless the manifest names the command', () => {
  const { gateRunnable } = gateModule;
  const memory = gateTable.getGate('memory');
  assert.equal(gateRunnable(memory, { commands: {} }).runnable, false);
  assert.equal(gateRunnable(memory, { commands: { memory: './memcheck.sh' } }).runnable, true);
});

test('gate: an unknown gate name is unrunnable rather than silently fine', () => {
  assert.equal(gateModule.gateRunnable(undefined, {}).runnable, false);
  assert.equal(gateModule.gateRunnable(gateTable.getGate('no-such-gate'), {}).runnable, false);
});

test('gates: planGates drops what the repo cannot run and names each one', () => {
  // The exact shape of the first real adoption: a Node/Workers repo with no prettier,
  // no lint script and no declared command.
  // `hono` matters: the i18n gate is implied by that tag alone (TAG_GATES), so a
  // stack without it never proposes the gate and never drops it.
  const { gates, dropped } = gateModule.planGates(['node', 'cloudflare-workers', 'hono'], {
    scripts: { test: 'vitest run', typecheck: 'tsc --noEmit' },
    binaries: ['vitest', 'tsc'],
    commands: {},
  });
  assert.deepEqual(gates.preCommit, []);
  assert.deepEqual(gates.prePush, ['test', 'typecheck']);
  const names = dropped.map((d) => d.gate).sort();
  assert.deepEqual(names, ['format', 'i18n-completeness', 'lint']);
  // Every drop carries a remedy. A drop the reader cannot undo is a decision the
  // tool made on their behalf and kept.
  for (const d of dropped) {
    assert.ok(d.why.length > 10, `${d.gate} must say why`);
    assert.ok(d.remedy.length > 10, `${d.gate} must carry a remedy`);
  }
  assert.match(dropped.find((d) => d.gate === 'format').remedy, /install prettier/);
  assert.match(dropped.find((d) => d.gate === 'lint').remedy, /"lint" script/);
  assert.match(dropped.find((d) => d.gate === 'i18n-completeness').remedy, /gates\.commands/);
});

test('gates: without a capability the stack table is taken at face value', () => {
  // Only sound for callers that verify the result afterwards, which init does.
  const { gates, dropped } = gateModule.planGates(['node'], null);
  assert.deepEqual(dropped, []);
  assert.deepEqual(gates.preCommit, ['format', 'lint']);
});

test('gates: an existing manifest keeps a gate the repo cannot run', () => {
  // Quietly disarming a gate somebody declared on purpose is a worse surprise than
  // a visible one, and check now reports it instead.
  const existing = { gates: { preCommit: ['format'], prePush: [] } };
  const { gates } = gateModule.buildManifest({
    root: '/x/y',
    stack: ['node'],
    existing,
    capability: { scripts: {}, binaries: [], commands: {} },
  });
  assert.deepEqual(gates.preCommit, ['format']);
});

test('gates: unrunnableGates reports a declared gate this repo cannot run', () => {
  const manifest = { gates: { preCommit: ['format'], prePush: ['test'] } };
  const findings = gateModule.unrunnableGates(manifest, {
    scripts: { test: 'vitest run' },
    binaries: [],
    commands: {},
  });
  assert.equal(findings.length, 1);
  assert.equal(findings[0].status, 'unrunnable');
  assert.equal(findings[0].gate, 'format');
  assert.match(findings[0].detail, /cannot run/);
  // The remedy must be the WHOLE fix. A re-init never re-adds a gate to a manifest
  // that already declares one, so "install prettier, re-run init" sends the reader
  // round the loop.
  assert.match(findings[0].remedy, /install prettier/);
  assert.match(findings[0].remedy, /then add "format" to gates\./);
  assert.ok(!/re-run/.test(findings[0].remedy), 'a landmine remedy must not tell the reader to re-init');
});

test('gates: unrunnableGates de-duplicates a gate named in both lists', () => {
  const manifest = { gates: { preCommit: ['lint'], prePush: ['lint'] } };
  assert.equal(
    gateModule.unrunnableGates(manifest, { scripts: {}, binaries: [], commands: {} }).length,
    1,
  );
});

test('gates: unrunnableGates is empty for a manifest that declares nothing', () => {
  assert.deepEqual(gateModule.unrunnableGates(null, {}), []);
  assert.deepEqual(gateModule.unrunnableGates({ gates: { preCommit: [], prePush: [] } }, {}), []);
});

test('capability: a repo with no package.json has no npm capability, and that is not an error', async () => {
  // A Python or Gradle repo has no package.json at all. That is a normal shape.
  const root = await scratch();
  const capability = await readCapability(root);
  assert.equal(capability.error, null);
  assert.deepEqual(capability.scripts, {});
  assert.deepEqual(capability.binaries, []);
});

test('capability: an unparseable package.json IS reported', async () => {
  const root = await scratch();
  await writeFile(join(root, 'package.json'), '{ not json');
  const capability = await readCapability(root);
  assert.match(capability.error, /package\.json/);
});

test('capability: binaries come from node_modules/.bin, not from dependencies', async () => {
  // A declared dependency with no install is not something the dispatcher can run.
  const root = await scratch();
  await writeFile(join(root, 'package.json'), JSON.stringify({ devDependencies: { prettier: '^3' } }));
  assert.deepEqual((await readCapability(root)).binaries, []);
  await mkdir(join(root, 'node_modules', '.bin'), { recursive: true });
  await writeFile(join(root, 'node_modules', '.bin', 'prettier'), '');
  await writeFile(join(root, 'node_modules', '.bin', '.package-lock'), '');
  assert.deepEqual((await readCapability(root)).binaries, ['prettier']);
});

test('capability: declaredCommands reads gates.commands and tolerates its absence', () => {
  assert.deepEqual(declaredCommands({ gates: { commands: { memory: './m.sh' } } }), { memory: './m.sh' });
  assert.deepEqual(declaredCommands({}), {});
  assert.deepEqual(declaredCommands(null), {});
});

// The end-to-end shape of the defect that motivated all of the above: a repo adopted
// by an older simt-dev, carrying gates it cannot run. The manifest was written before
// this fix, so nothing else will ever correct it — `sync` does not own the manifest.
test('check reports a landmine gate left by an older adoption (end to end)', async () => {
  const { initCommand } = await import('../src/commands/init.mjs');
  const { checkCommand } = await import('../src/commands/sync.mjs');
  const root = await scratch();
  await writeFile(join(root, 'wrangler.jsonc'), '');
  await writeFile(
    join(root, 'package.json'),
    JSON.stringify({ name: 'x', scripts: { test: 'vitest run', typecheck: 'tsc' } }),
  );
  await mkdir(join(root, 'node_modules', '.bin'), { recursive: true });
  await writeFile(join(root, 'node_modules', '.bin', 'vitest'), '');

  assert.equal(await initCommand([], { root, yes: true }), 0);
  assert.equal(await checkCommand([], { root }), 0);

  // Simulate the older adoption: gates hand-written into the manifest.
  const path = join(root, 'simt-dev.json');
  const manifest = JSON.parse(await readFile(path, 'utf8'));
  manifest.gates.preCommit = ['format', 'lint', 'i18n-completeness'];
  await writeFile(path, `${JSON.stringify(manifest, null, 2)}\n`);

  assert.equal(await checkCommand([], { root }), 1);
});

test('check stays green when a declared gate can run (no false alarm)', async () => {
  const { initCommand } = await import('../src/commands/init.mjs');
  const { checkCommand } = await import('../src/commands/sync.mjs');
  const root = await scratch();
  await writeFile(join(root, 'package.json'), JSON.stringify({ name: 'x', scripts: { test: 'vitest run' } }));
  await mkdir(join(root, 'node_modules', '.bin'), { recursive: true });
  await writeFile(join(root, 'node_modules', '.bin', 'vitest'), '');
  await writeFile(join(root, 'node_modules', '.bin', 'prettier'), '');
  assert.equal(await initCommand([], { root, yes: true }), 0);
  assert.equal(await checkCommand([], { root }), 0);
});

test('check does not fire on a repo with no manifest at all', async () => {
  const { checkCommand } = await import('../src/commands/sync.mjs');
  const root = await scratch();
  // Not `current` for the absent AGENTS.md, but never an UNRUNNABLE gate.
  assert.equal(await checkCommand([], { root }), 1);
});

test('init PRINTS each dropped gate with its remedy; a re-init reports none', async () => {
  // A silently shorter gate list reads as "this repo needs no formatting check",
  // when the truth is "declaring one would block every commit".
  const { initCommand } = await import('../src/commands/init.mjs');
  const root = await scratch();
  await writeFile(join(root, 'package.json'), JSON.stringify({ name: 'x', scripts: { test: 'vitest run' } }));

  // Applied, not a dry run: the point is that the manifest now exists, which is what
  // silences the second report.
  const first = await capture(() => initCommand([], { root, yes: true }));
  assert.equal(first.code, 0);
  assert.match(first.text, /dropped +gate format: prettier is not installed/);
  assert.match(first.text, /dropped +gate lint: no "lint" script/);
  assert.match(first.text, /remedy: install prettier/);
  // The manifest it would write must not contain the dropped gate.
  assert.match(first.text, /preCommit=\(none\)/);

  // A second init on a repo that now declares gates reports no drops, because the
  // drops describe proposals that were never made.
  const second = await capture(() => initCommand([], { root, yes: true }));
  assert.equal(second.code, 0);
  assert.ok(!/dropped +gate/.test(second.text), 're-init reported drops for gates it did not propose');
});
