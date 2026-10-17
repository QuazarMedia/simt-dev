import assert from 'node:assert/strict';
import { test } from 'node:test';
import { chmod, mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import * as gateModule from '../src/projection/manifest.mjs';
import * as gateTable from '../src/hooks/gates.mjs';
import { readCapability, declaredCommands } from '../src/hooks/capability.mjs';
import { git, cmd } from './fixture.mjs';
import { CLI, MANIFEST_FILE, MANIFEST_LEGACY } from '../src/name.mjs';
import { packageVersion } from '../src/package-version.mjs';

const buildManifest = gateModule.buildManifest;

async function capture(run) {
  // Both streams. A trailing `next`/`hooks` line goes to stderr on purpose: it is
  // advice about what to do after this command, and a caller piping stdout to a file
  // should not find it there.
  const out = [];
  const err = [];
  const realOut = process.stdout.write.bind(process.stdout);
  const realErr = process.stderr.write.bind(process.stderr);
  process.stdout.write = (c) => { out.push(String(c)); return true; };
  process.stderr.write = (c) => { err.push(String(c)); return true; };
  let code;
  try {
    code = await run();
  } finally {
    process.stdout.write = realOut;
    process.stderr.write = realErr;
  }
  return { code, text: `${out.join('')}${err.join('')}` };
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

test('manifest: a re-init keeps a key it does not own', () => {
  const plans = { directories: [{ kind: 'plans', path: 'planning' }] };
  const existing = { plans, notes: 'kept' };
  const next = buildManifest({ root: '/x/y', stack: ['node'], sha: 'abc', existing });
  assert.deepEqual(next.plans, plans);
  assert.equal(next.notes, 'kept');
  assert.equal(next.projection.simtDevSha, 'abc');
  const keys = Object.keys(next);
  assert.ok(keys.indexOf('plans') > keys.indexOf('projection'));
  assert.ok(keys.indexOf('notes') > keys.indexOf('plans'));
  const fresh = buildManifest({ root: '/x/y', stack: ['node'] });
  assert.equal(Object.hasOwn(fresh, 'plans'), false);
  assert.equal(Object.hasOwn(fresh, 'notes'), false);
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
  await assert.rejects(readFile(join(root, MANIFEST_FILE), 'utf8'));
});

test('init: a conflicting repo is blocked before any write', async () => {
  const { initCommand } = await import('../src/commands/init.mjs');
  const root = await scratch();
  await writeFile(join(root, 'monkey.jungle'), '');
  await writeFile(join(root, 'AGENTS.md'), '# Rules\n\n8. Committed and pushed with a conventional message\n');
  const code = await initCommand([], { root, yes: true });
  assert.equal(code, 1, 'a conflict must block even with --yes');
  await assert.rejects(readFile(join(root, MANIFEST_FILE), 'utf8'));
});

test('init: --accept-conflicts proceeds and writes both files', async () => {
  const { initCommand } = await import('../src/commands/init.mjs');
  const root = await scratch();
  await writeFile(join(root, 'monkey.jungle'), '');
  const agents = '# Rules\n\n1. Committed and pushed with a conventional message\n';
  await writeFile(join(root, 'AGENTS.md'), agents);
  const code = await initCommand([], { root, yes: true, acceptConflicts: true });
  assert.equal(code, 0);
  const manifest = JSON.parse(await readFile(join(root, MANIFEST_FILE), 'utf8'));
  assert.ok(manifest.projection.simtDevSha);
  const after = await readFile(join(root, 'AGENTS.md'), 'utf8');
  // The hand-written line survives verbatim: init never overwrites prose.
  assert.ok(after.startsWith(agents.trimEnd()));
  assert.ok(after.includes('simt:begin'));
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
  assert.ok(after.includes('simt:begin'));
  assert.ok(after.includes('simt:end'));
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
  await git(['commit', '-qm', 'base'], { cwd: root });

  await initCommand([], { root, yes: true });

  const { stdout: log } = await run('git', ['log', '--oneline'], { cwd: root });
  assert.equal(log.trim().split('\n').length, 1, 'init must not create a commit');
  const { stdout } = await run('git', ['status', '--porcelain'], { cwd: root });
  assert.match(stdout, cmd('{manifest}'), 'files are left uncommitted for review');
});

test('init: a repo with no commits is still adoptable', async () => {
  // The default run creates no git objects at all (ADR-063), so an unborn repo is
  // adoptable for the trivial reason that there is nothing to tag or branch. With
  // --backup the escape hatch degrades to a note rather than blocking, because
  // refusing to initialise would be worse.
  const { initCommand } = await import('../src/commands/init.mjs');
  const { execFile } = await import('node:child_process');
  const { promisify } = await import('node:util');
  const run = promisify(execFile);

  const root = await scratch();
  await run('git', ['init', '-q'], { cwd: root });
  await writeFile(join(root, 'monkey.jungle'), '');

  assert.equal(await initCommand([], { root, yes: true }), 0);
  const manifest = await readFile(join(root, MANIFEST_FILE), 'utf8');
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
  assert.equal(capability.runner, 'none');
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

test('capability: the runner is npm when there is a package.json', async () => {
  const root = await scratch();
  await writeFile(join(root, 'package.json'), JSON.stringify({ scripts: { test: 'vitest' } }));
  assert.equal((await readCapability(root)).runner, 'npm');
});

test('capability: a non-npm runner is identified from a FILE, not a directory', async () => {
  // The first cut of this used `readdir` to test existence, which answers "no" for
  // every file (ENOTDIR) and so classified every Gradle repo as having no runner. A
  // wrong answer from an evidence reader is worse than no answer.
  const root = await scratch();
  await writeFile(join(root, 'gradlew'), '#!/bin/sh\n');
  assert.equal((await readCapability(root)).runner, 'gradle');

  const py = await scratch();
  await writeFile(join(py, 'pyproject.toml'), '[project]\n');
  assert.equal((await readCapability(py)).runner, 'python');

  const cargo = await scratch();
  await writeFile(join(cargo, 'Cargo.toml'), '[package]\n');
  assert.equal((await readCapability(cargo)).runner, 'cargo');
});

test('capability: npm wins over a stray non-npm marker', async () => {
  // simt-app carries .py tooling scripts and a Gradle wrapper; a repo with package.json
  // is an npm repo, whatever else is lying around in it.
  const root = await scratch();
  await writeFile(join(root, 'package.json'), JSON.stringify({ scripts: {} }));
  await writeFile(join(root, 'gradlew'), '#!/bin/sh\n');
  assert.equal((await readCapability(root)).runner, 'npm');
});

test('a dropped npm-shaped gate explains itself in the repo\'s own ecosystem', async () => {
  // The defect this closes: on a Gradle repo the remedy read "add a \"test\" script to
  // package.json" — a file that repo will never have, so the undo was impossible.
  const gradle = { runner: 'gradle', scripts: {}, binaries: [], commands: {} };
  const { dropped } = gateModule.planGates(['gradle'], gradle);
  const test = dropped.find((d) => d.gate === 'test');
  assert.match(test.why, /Gradle, not npm/);
  assert.match(test.remedy, /Gradle, not npm/);
  assert.match(test.remedy, /gates\.commands/);
  assert.doesNotMatch(test.remedy, /package\.json/);
});

test('an npm repo keeps the npm remedy, and a capability that reports no runner is assumed npm', async () => {
  // A caller that builds a capability by hand may leave `runner` unset. Claiming such a
  // repo has no package.json is a far worse guess than assuming it does.
  const npm = { runner: 'npm', scripts: {}, binaries: [], commands: {} };
  const blind = { scripts: {}, binaries: [], commands: {} };
  for (const capability of [npm, blind]) {
    const { dropped } = gateModule.planGates(['node'], capability);
    const lint = dropped.find((d) => d.gate === 'lint');
    assert.match(lint.remedy, /add a "lint" script to package\.json/);
    assert.doesNotMatch(lint.remedy, /not npm/);
  }
});

test('capability: declaredCommands reads gates.commands and tolerates its absence', () => {
  assert.deepEqual(declaredCommands({ gates: { commands: { memory: './m.sh' } } }), { memory: './m.sh' });
  assert.deepEqual(declaredCommands({}), {});
  assert.deepEqual(declaredCommands(null), {});
});

// ---------------------------------------------------------------------------
// Ecosystem seeding (S40). A marker file says the ecosystem is in the repo;
// only a probe of THIS machine says its program can run. A fresh adoption
// declares the canonical command for each proposed gate when both are true,
// and drops the gate with a remedy when either is false — a declared gate
// that cannot run blocks every commit, so the seed must not fire on the
// marker's word alone (ADR-017, reached from the ecosystem table).
// ---------------------------------------------------------------------------

test('gates: every ecosystem row seeds its canonical commands when the tool can run', () => {
  for (const eco of gateModule.ECOSYSTEMS) {
    const { gates, dropped, commands } = gateModule.planGates(
      [],
      { runner: 'none', scripts: {}, binaries: [], commands: {}, tools: [eco.tool] },
      [eco.fact],
    );
    assert.deepEqual(commands, eco.commands, `${eco.fact}: ${JSON.stringify(commands)}`);
    // A seeded gate must be a gate the repo can run: the seed IS its runnability.
    for (const name of Object.keys(commands)) {
      assert.ok(
        !dropped.some((d) => d.gate === name),
        `${eco.fact}: seeded ${name} but it is also dropped: ${JSON.stringify(dropped)}`,
      );
      assert.ok(
        gates.preCommit.includes(name) || gates.prePush.includes(name),
        `${eco.fact}: seeded ${name} but it is not in the gate lists`,
      );
    }
  }
});

test('gates: a marker without the toolchain drops every proposed gate and declares none', () => {
  for (const eco of gateModule.ECOSYSTEMS) {
    const { commands, dropped } = gateModule.planGates(
      [],
      { runner: 'none', scripts: {}, binaries: [], commands: {}, tools: [] },
      [eco.fact],
    );
    assert.deepEqual(commands, {}, `${eco.fact} must not declare a command it cannot run`);
    // A row proposes what it has: the Maven row has no preCommit gates.
    for (const name of new Set([...(eco.preCommit ?? []), ...(eco.prePush ?? [])])) {
      const d = dropped.find((x) => x.gate === name);
      assert.ok(d, `${eco.fact}: ${name} must be dropped, not silently absent`);
      assert.ok(d.why.length > 10, `${eco.fact}: ${name} must say why`);
      assert.ok(d.remedy.length > 10, `${eco.fact}: ${name} must carry a remedy`);
    }
  }
});

test('gates: an npm runner keeps its own scripts; no seed lands on top of them', () => {
  // package.json is the repo's own answer to "how do I test and format". A seed
  // outranks a script only where the repo has not declared a command of its own —
  // exactly the mixed repos (package.json AND Cargo.toml) where the script is the
  // deliberate answer. Replacing a choice with a default is what this guard stops.
  const { commands, dropped } = gateModule.planGates(
    ['node'],
    {
      runner: 'npm',
      scripts: { test: 'vitest run', lint: 'eslint .', typecheck: 'tsc --noEmit' },
      binaries: ['prettier'],
      commands: {},
      tools: ['cargo'],
    },
    ['has-cargo-toml'],
  );
  assert.deepEqual(commands, {}, 'a seed must not override an npm repo\'s scripts');
  assert.deepEqual(dropped, [], 'the scripts answer every proposed gate: ' + JSON.stringify(dropped));
});

test('gates: a command the repo already declared is not re-seeded', () => {
  // A seed is a default and a declaration is a choice; the default losing to the
  // choice is the whole reason `effective` merges declaration last.
  const { commands } = gateModule.planGates(
    [],
    { runner: 'cargo', scripts: {}, binaries: [], commands: { test: 'just my tests' }, tools: ['cargo'] },
    ['has-cargo-toml'],
  );
  assert.deepEqual(commands, { format: 'cargo fmt --check', lint: 'cargo clippy -- -D warnings' });
});

test('capability: ecosystem tools are probed on PATH, not assumed', async () => {
  // The probe is deterministic: with a controlled PATH the answer cannot depend on
  // what happens to be installed on the machine running the suite.
  const root = await scratch();
  await writeFile(join(root, 'Cargo.toml'), '[package]\nname="x"\n');
  const bin = await scratch();
  await writeFile(join(bin, 'cargo'), '#!/bin/sh\nexit 0\n');
  await chmod(join(bin, 'cargo'), 0o755);

  const saved = process.env.PATH;
  try {
    process.env.PATH = bin;
    assert.ok((await readCapability(root)).tools.includes('cargo'), 'a tool on PATH is found');
    const empty = await scratch();
    process.env.PATH = empty;
    assert.ok(!(await readCapability(root)).tools.includes('cargo'), 'a tool off PATH is not assumed');
  } finally {
    process.env.PATH = saved;
  }
});

test('capability: a file tool (the Maven wrapper) is probed in the repo, executable or not', async () => {
  // A wrapper that exists but is not executable would be declared and then fail on
  // every commit; the probe must answer no for it.
  const root = await scratch();
  await writeFile(join(root, 'pom.xml'), '<project/>\n');
  await writeFile(join(root, 'mvnw'), '#!/bin/sh\n');
  const saved = process.env.PATH;
  try {
    process.env.PATH = await scratch();
    assert.ok(!(await readCapability(root)).tools.includes('mvnw'), 'a non-executable wrapper is not a tool');
    await chmod(join(root, 'mvnw'), 0o755);
    assert.ok((await readCapability(root)).tools.includes('mvnw'), 'an executable wrapper is a tool');
  } finally {
    process.env.PATH = saved;
  }
});

test('init: a fresh Rust repo with cargo on PATH gets runnable seeded gates (S40)', async () => {
  // End to end: marker file, probed tool, manifest that runs. The seeded commands
  // are the gates\' runnability — a manifest with the gate list and no commands
  // would be red on the first commit.
  const { initCommand } = await import('../src/commands/init.mjs');
  const root = await scratch();
  await mkdir(join(root, 'src'), { recursive: true });
  await writeFile(join(root, 'Cargo.toml'), '[package]\nname="x"\n');
  await writeFile(join(root, 'src', 'main.rs'), 'fn main() {}\n');
  const bin = await scratch();
  await writeFile(join(bin, 'cargo'), '#!/bin/sh\nexit 0\n');
  await chmod(join(bin, 'cargo'), 0o755);

  const saved = process.env.PATH;
  try {
    process.env.PATH = bin;
    const { code, text } = await capture(() => initCommand([], { root, yes: true }));
    assert.equal(code, 0, text);
    const manifest = JSON.parse(await readFile(join(root, MANIFEST_FILE), 'utf8'));
    assert.deepEqual(manifest.gates.commands, {
      format: 'cargo fmt --check',
      lint: 'cargo clippy -- -D warnings',
      test: 'cargo test',
    });
    assert.ok(manifest.gates.preCommit.includes('format'));
    assert.ok(manifest.gates.prePush.includes('test'));
    // A write the reader was not shown is approved from the diff afterwards; the
    // plan prints every seeded line.
    assert.match(text, /seeded +gates\.commands\["test"\] = cargo test/);
  } finally {
    process.env.PATH = saved;
  }
});

test('init: a fresh Rust repo without cargo declares the gates it cannot run as drops (S40)', async () => {
  const { initCommand } = await import('../src/commands/init.mjs');
  const root = await scratch();
  await mkdir(join(root, 'src'), { recursive: true });
  await writeFile(join(root, 'Cargo.toml'), '[package]\nname="x"\n');
  const bin = await scratch();

  const saved = process.env.PATH;
  try {
    process.env.PATH = bin;
    const { code, text } = await capture(() => initCommand([], { root, yes: true }));
    assert.equal(code, 0, text);
    const manifest = JSON.parse(await readFile(join(root, MANIFEST_FILE), 'utf8'));
    assert.equal(manifest.gates.commands, undefined, 'no toolchain means no declared command');
    // Every proposed gate that cannot run is named, with the undo.
    assert.match(text, /dropped +gate test: /);
    assert.match(text, /gates\.commands/);
    assert.ok(!/seeded/.test(text), 'nothing was seeded: ' + text);
  } finally {
    process.env.PATH = saved;
  }
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
  const path = join(root, MANIFEST_FILE);
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

// The manifest declares what the repo promises to enforce, and nothing enforces it
// until the dispatcher is installed. `init` used to finish without saying so, so a
// fully adopted, check-green repo could enforce nothing at all - the exact state the
// first adoption reached.
test('init says out loud that declared gates are not yet enforced', async () => {
  const { initCommand } = await import('../src/commands/init.mjs');
  const root = await scratch();
  await writeFile(join(root, 'package.json'), JSON.stringify({ name: 'x', scripts: { test: 'vitest run' } }));
  await mkdir(join(root, 'node_modules', '.bin'), { recursive: true });
  await writeFile(join(root, 'node_modules', '.bin', 'vitest'), '');

  const first = await capture(() => initCommand([], { root, yes: true }));
  assert.equal(first.code, 0);
  assert.match(first.text, /NOT ENFORCED yet - test is declared but no hook runs them/);
  assert.match(first.text, cmd('{cli} hooks install'));

});

test('init says there is nothing to install when the repo can run no gate', async () => {
  // An empty gate list is a valid manifest - a repo with no formatter and no linter.
  // It must not be reported as an outstanding step.
  const { initCommand } = await import('../src/commands/init.mjs');
  const root = await scratch();
  await writeFile(join(root, 'package.json'), JSON.stringify({ name: 'x' }));
  const run = await capture(() => initCommand([], { root, yes: true }));
  assert.equal(run.code, 0);
  assert.match(run.text, /declares no gate it can run, so there is nothing to install/);
  assert.ok(!/NOT ENFORCED/.test(run.text), 'an empty gate list must not read as an outstanding step');
});

// A generated file that another tool reformats is not wrong, and it is not
// fixable by hand either: the next `init` writes simt-dev's bytes and the
// formatter takes them away. simt-space held a prettier-collapsed manifest and
// `upgrade` reported `current` for the whole time, because the pin really was
// current. Only the bytes were wrong, and nothing looked at them.
test('a manifest a formatter rewrote is reported, and a hand-edited one is not', async () => {
  const { MANIFEST_COMMENT, manifestDrift } = await import('../src/projection/manifest.mjs');
  const root = await scratch();
  const stack = ['node'];
  const sha = 'abc1234';
  // The pin this build records: manifestDrift computes the expected projection with
  // packageVersion(), so the bytes the test writes must carry the same value to read
  // as current rather than stale.
  const version = packageVersion();
  const write = async (m) => writeFile(join(root, MANIFEST_FILE), `${JSON.stringify(m, null, 2)}\n`);
  const canonical = {
    ...MANIFEST_COMMENT,
    id: 'r',
    stack,
    limits: { coverage: null, fileLines: { warn: 400, error: 1000 } },
    gates: { preCommit: [], prePush: [] },
    localSkills: [], profiles: [], substitutions: {}, surfaces: null,
    projection: { simtDevSha: sha, version },
  };

  await write(canonical);
  assert.equal(await manifestDrift(root, stack, sha), null, 'canonical bytes must not be reported');

  // Prettier's JSON style: objects expanded, short arrays collapsed onto one line.
  // Every generated field stays correct; only the byte form differs.
  await writeFile(
    join(root, MANIFEST_FILE),
    [
      '{',
      `  "$comment": ${JSON.stringify(MANIFEST_COMMENT.$comment)},`,
      '  "id": "r",',
      '  "stack": ["node"],',
      '  "limits": {"coverage": null, "fileLines": {"warn": 400, "error": 1000}},',
      '  "gates": {"preCommit": [], "prePush": []},',
      '  "localSkills": [],',
      '  "profiles": [],',
      '  "substitutions": {},',
      '  "surfaces": null,',
      `  "projection": {"simtDevSha": "${sha}", "version": "${version}"}`,
      '}',
      '',
    ].join('\n'),
  );
  const reformatted = await manifestDrift(root, stack, sha);
  assert.equal(reformatted?.status, 'reformatted');
  assert.match(reformatted.remedy, /\.prettierignore/);

  // A value the REPO chose is never compared. simt-app removed its gradle pre-push
  // gate by hand and that edit must survive `check`.
  await write({ ...canonical, limits: { coverage: 100, fileLines: { warn: 400, error: 1000 } } });
  assert.equal(await manifestDrift(root, stack, sha), null, "a hand-set limit is the repo's own choice");

  // A generated field the writer has moved on from IS reported - this is the defect
  // that shipped in c607d0a's fix for the $comment and never covered the general case.
  await write({ ...canonical, $comment: 'an older header' });
  const stale = await manifestDrift(root, stack, sha);
  assert.equal(stale?.status, 'stale-generated-field');
  assert.match(stale.detail, /\$comment/);
});

test('check is red when the manifest bytes are not what simt-dev writes', async () => {
  const { initCommand } = await import('../src/commands/init.mjs');
  const { checkCommand } = await import('../src/commands/sync.mjs');
  const root = await scratch();
  await writeFile(join(root, 'package.json'), JSON.stringify({ name: 'x' }));
  await capture(() => initCommand([], { root, yes: true }));
  assert.equal((await capture(() => checkCommand([], { root }))).code, 0);

  const path = join(root, MANIFEST_FILE);
  const m = JSON.parse(await readFile(path, 'utf8'));
  await writeFile(path, `${JSON.stringify(m, null, 4)}\n`);
  const after = await capture(() => checkCommand([], { root }));
  assert.equal(after.code, 1);
  assert.match(after.text, cmd('REFORMATTED {manifest}'));
});

// The manifest was the second file this tool writes into a repository it does not
// own, and for two releases it was the only generated file with no path back to
// correct. `check` refused on a stale generated field and named `init --yes`; `sync`
// — the command whose entire job is regenerating what this tool owns — reported
// "already current; nothing written". Both were true of the same repository at once,
// and in all fourteen adopted repositories at once: `check` exited 1 in every one
// while `compare` reported `current: 14`. Measured, not inferred.
test('sync repairs the manifest field check refuses, and previews it first', async () => {
  const { syncCommand } = await import('../src/commands/sync.mjs');
  const { MANIFEST_COMMENT, manifestDrift } = await import('../src/projection/manifest.mjs');
  const { provenanceDigest } = await import('../src/projection/project.mjs');
  const root = await scratch();
  const stack = ['node'];
  // The real digest, because `sync` stamps the one this build computes. A fixture sha
  // of 'abc1234' makes the field genuinely stale, and then the test below is
  // measuring the repair rather than the preview.
  const sha = await provenanceDigest();
  // A manifest from before `projection.version` existed: every generated field this
  // build writes is absent or wrong, and every value in the file is true.
  await writeFile(join(root, 'package.json'), JSON.stringify({ name: 'x' }));
  await writeFile(
    join(root, MANIFEST_FILE),
    `${JSON.stringify(
      {
        ...MANIFEST_COMMENT,
        id: 'r',
        stack,
        limits: { coverage: null, fileLines: { warn: 400, error: 1000 } },
        gates: { preCommit: [], prePush: [] },
        localSkills: [], profiles: [], substitutions: {}, surfaces: null,
        projection: { simtDevSha: sha },
      },
      null,
      2,
    )}\n`,
  );

  const before = await readFile(join(root, MANIFEST_FILE), 'utf8');
  const drift = await manifestDrift(root, stack, sha);
  assert.equal(drift?.status, 'stale-generated-field', 'the fixture must actually be stale');

  // A preview: no bytes move, and the plan says what would.
  const preview = await capture(() => syncCommand([], { root }));
  assert.equal(preview.code, 1, 'a preview that found work exits non-zero, so bare sync doubles as a check');
  assert.match(preview.text, /simt\.json\s+updated/, `the plan must name the manifest:\n${preview.text}`);
  assert.match(preview.text, new RegExp(`apply with: ${CLI} sync --yes`), 'the preview names the command that writes it');
  assert.equal(await readFile(join(root, MANIFEST_FILE), 'utf8'), before, 'a preview wrote nothing');

  // The write: this tool's fields replaced, the repository's own left alone.
  const applied = await capture(() => syncCommand([], { root, yes: true }));
  assert.equal(applied.code, 0);
  const after = JSON.parse(await readFile(join(root, MANIFEST_FILE), 'utf8'));
  assert.deepEqual(after.projection, { simtDevSha: sha, version: packageVersion() });
  assert.equal(await manifestDrift(root, stack, sha), null, 'the gate must agree the repair worked');

  // The value the repository chose, and the one the tool deliberately does not touch.
  // A repair built from `buildManifest`'s output rather than a spread would reset
  // both of these to a default, and the drift check would never have noticed.
  assert.deepEqual(after.limits, { coverage: null, fileLines: { warn: 400, error: 1000 } });
  assert.deepEqual(after.gates, { preCommit: [], prePush: [] });
  assert.equal(after.id, 'r');
  assert.deepEqual(after.stack, stack);

  // And it converges: a second run finds nothing, which is what stops `sync --yes`
  // from being a command that always reports work.
  const again = await capture(() => syncCommand([], { root, yes: true }));
  assert.equal(again.code, 0);
  assert.match(again.text, /already current/);
});

test('sync repairs a reformatted manifest only once the repo ignores it', async () => {
  const { syncCommand } = await import('../src/commands/sync.mjs');
  const { manifestDrift, MANIFEST_COMMENT } = await import('../src/projection/manifest.mjs');
  const { provenanceDigest } = await import('../src/projection/project.mjs');
  const root = await scratch();
  const stack = ['node'];
  // The stamp is this build's own digest, so the ONLY thing wrong with this manifest
  // is its bytes. A fixture sha of 'abc1234' would also be a stale generated field,
  // which sync is supposed to repair - so the test would be asserting the other branch.
  const sha = await provenanceDigest();
  // Every generated field correct, only the byte form a prettier hook produced.
  const bytes = [
    '{',
    `  "$comment": ${JSON.stringify(MANIFEST_COMMENT.$comment)},`,
    '  "id": "r",',
    '  "stack": ["node"],',
    '  "limits": {"coverage": null, "fileLines": {"warn": 400, "error": 1000}},',
    '  "gates": {"preCommit": [], "prePush": []},',
    '  "localSkills": [],',
    '  "profiles": [],',
    '  "substitutions": {},',
    '  "surfaces": null,',
    `  "projection": {"simtDevSha": "${sha}", "version": "${packageVersion()}"}`,
    '}',
    '',
  ].join('\n');
  await writeFile(join(root, 'package.json'), JSON.stringify({ name: 'x' }));
  await writeFile(join(root, MANIFEST_FILE), bytes);
  assert.equal((await manifestDrift(root, stack, sha))?.status, 'reformatted');

  // While a formatter still owns the file, sync leaves it alone. Repairing here would
  // mean every `format` run rewrites a file the commit just wrote: a working tree that
  // is never clean.
  const untouched = await capture(() => syncCommand([], { root, yes: true }));
  assert.equal(untouched.code, 0);
  assert.equal(
    await readFile(join(root, MANIFEST_FILE), 'utf8'),
    bytes,
    'sync rewrote a file whose bytes a formatter still owns',
  );

  // The repository declares the file is not prose. That is the signal, read rather
  // than assumed - so lines that do not name the manifest must NOT count, including a
  // comment about generated files, which is the shape an operator writes first.
  for (const line of ['# generated files are not prose', 'node_modules/', '*.json']) {
    await writeFile(join(root, '.prettierignore'), `${line}\n`);
    await writeFile(join(root, MANIFEST_FILE), bytes);
    const run = await capture(() => syncCommand([], { root, yes: true }));
    assert.equal(run.code, 0);
    assert.equal(
      await readFile(join(root, MANIFEST_FILE), 'utf8'),
      bytes,
      `\`${line}\` is not a declaration about this one file, so sync must not rewrite it`,
    );
  }

  // Naming it is. Both spellings, because the legacy name is what a repository adopted
  // before the rename still has on disk.
  for (const line of [MANIFEST_FILE, MANIFEST_LEGACY]) {
    await writeFile(join(root, '.prettierignore'), `# generated files\n${line}\n`);
    await writeFile(join(root, MANIFEST_FILE), bytes);
    const run = await capture(() => syncCommand([], { root, yes: true }));
    assert.equal(run.code, 0);
    assert.notEqual(
      await readFile(join(root, MANIFEST_FILE), 'utf8'),
      bytes,
      `with ${line} in .prettierignore, sync must put simt-dev's bytes back`,
    );
    assert.equal(
      await manifestDrift(root, stack, sha),
      null,
      'and the gate must agree the manifest is now correct',
    );
  }

  // An unreadable `.prettierignore` is not an absent one. This assertion exists
  // because the first version of that read was `catch { return false }`, and a
  // ReferenceError from a missing import was swallowed by it and read as "this
  // repository has declared nothing" — silently, on every repository, forever. A
  // directory is the one unreadable shape a fixture can build on purpose; ENOENT is
  // the only absence, and it is still absence.
  await rm(join(root, '.prettierignore'), { force: true });
  await mkdir(join(root, '.prettierignore'), { recursive: true });
  await writeFile(join(root, MANIFEST_FILE), bytes);
  await assert.rejects(
    () => syncCommand([], { root, yes: true }),
    (error) => error.code === 'EISDIR',
    'an unreadable .prettierignore must surface, not read as "no declaration"',
  );
});

test('the remedy for a stale manifest field names the command that repairs it', async () => {
  // Two commands must not answer one question with different instructions
  // (ADR-050). `init` re-runs adoption - it tags, it branches - so naming it as the
  // remedy for one stale field is naming a command that does more than the reader
  // asked for, while naming the wrong one is naming a command that cannot help.
  const { manifestDrift } = await import('../src/projection/manifest.mjs');
  const root = await scratch();
  await writeFile(join(root, MANIFEST_FILE), `${JSON.stringify({ projection: { simtDevSha: 'a' } }, null, 2)}\n`);
  const stale = await manifestDrift(root, ['node'], 'b');
  assert.equal(stale?.status, 'stale-generated-field');
  assert.match(stale.remedy, new RegExp(`^run: ${CLI} sync --yes$`), `unexpected remedy: ${stale.remedy}`);
  assert.doesNotMatch(stale.remedy, /init/, 'init re-runs adoption; it is not the repair for one field');
});

test('init --backup: the branch and the tag it creates are both reported (S15)', async () => {
  // With --backup both operations happen, and the heading over plan 0002 §8.2's list
  // is "Nothing is silent". Both were once reported only under `--json`, so the run —
  // the one almost everybody reads — did not say that the branch under them had
  // changed. (ADR-063 made the pair opt-in; the reporting requirement stands for
  // whatever a run does to git state.)
  //
  // The claim under test is about what a reader SEES, so it is asserted on the printed
  // output rather than on the returned payload, which already carried both.
  const { initCommand } = await import('../src/commands/init.mjs');
  const root = await scratch();
  await git(['init', '-q'], { cwd: root });
  await writeFile(join(root, 'notes.txt'), 'x\n');
  await git(['add', '-A'], { cwd: root });
  await git(['commit', '-qm', 'init'], { cwd: root });

  // `capture` collects both streams, which is where a reader looks too.
  const { code, text } = await capture(() => initCommand([], { root, yes: true, backup: true }));
  assert.equal(code, 0);

  // The in-place note is the other half of "Nothing is silent": without --backup the
  // run says it did not branch or tag. With --backup there is nothing to excuse, so
  // the note must not appear.
  assert.doesNotMatch(text, /in place   no backup tag/, '--backup run must not report in-place');

  assert.match(text, /tagged\s+backup-before-simt-dev/, 'the tag it wrote was not reported');
  assert.match(text, /git reset --hard backup-before-simt-dev/, 'and not how to undo it');
  assert.match(text, /branch\s+switched to simt-dev\/adopt/, 'the branch it switched to was not reported');

  // And the commands named must be the ones that work. An escape hatch that prints the
  // wrong way out is worse than one that prints nothing, because it is believed.
  const { stdout: after } = await git(['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: root });
  assert.match(after.trim(), /^simt-dev\/adopt$/, 'the test did not actually switch branches');
  const { stdout: branches } = await git(['branch', '--format=%(refname:short)'], { cwd: root });
  assert.match(branches, /\bmaster\b|\bmain\b/, 'the previous branch is gone; the message claims it is untouched');

  // The branch line names the branch it came FROM, and that name must be real.
  const from = /branch\s+switched to simt-dev\/adopt;\s+(\S+)\s+is untouched/.exec(text);
  assert.ok(from, 'the branch line does not name the branch it left');
  assert.ok(
    branches.split('\n').includes(from[1]),
    `the branch line names "${from[1]}", which is not a branch in this repository`,
  );
});

test('init without --backup writes in place: no tag, no branch (ADR-063)', async () => {
  // The default is in place: the adoption lands on the branch the reader already has,
  // and no git object is created. The in-place note says so, and names the flag that
  // restores the undo path. A reader who ran the documented flow without choosing an
  // escape hatch must not find a branch they did not ask for under them.
  const { initCommand } = await import('../src/commands/init.mjs');
  const root = await scratch();
  await git(['init', '-q'], { cwd: root });
  await writeFile(join(root, 'notes.txt'), 'x\n');
  await git(['add', '-A'], { cwd: root });
  await git(['commit', '-qm', 'init'], { cwd: root });
  const { stdout: before } = await git(['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: root });

  const { code, text } = await capture(() => initCommand([], { root, yes: true }));
  assert.equal(code, 0);

  const { stdout: after } = await git(['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: root });
  assert.equal(after.trim(), before.trim(), 'the reader must stay on the branch they were on');
  const { stdout: branches } = await git(['branch', '--format=%(refname:short)'], { cwd: root });
  assert.doesNotMatch(branches, /simt-dev\/adopt/, 'an adopt branch was created without --backup');
  await assert.rejects(
    () => git(['rev-parse', '--verify', 'refs/tags/backup-before-simt-dev'], { cwd: root }),
    'a backup tag was created without --backup',
  );

  // And the run says what it did instead, with the flag that gives the undo path.
  assert.match(text, /in place   no backup tag or adopt branch/, 'the in-place behaviour was not reported');
  assert.match(text, /--backup/, 'and the flag that restores the undo path was not named');

  // The adoption itself still happened, in place.
  const manifest = await readFile(join(root, MANIFEST_FILE), 'utf8');
  assert.ok(manifest.length > 0, 'the manifest was not written in place');
});

test('init --backup: a directory that is not a git work tree reports no branch and no tag', async () => {
  // The escape hatch is best-effort (plan 0002: a repo with no commits must still be
  // adoptable), so the notes carry the reason. What must not happen is the tool
  // claiming a tag or a branch it did not create.
  const { initCommand } = await import('../src/commands/init.mjs');
  const root = await scratch();
  await writeFile(join(root, 'monkey.jungle'), '');
  const { code, text } = await capture(() => initCommand([], { root, yes: true, backup: true }));
  assert.equal(code, 0);
  assert.doesNotMatch(text, /^tagged /m, 'a tag was reported in a repository with no git');
  assert.doesNotMatch(text, /^branch   switched/m, 'a branch switch was reported in a repository with no git');
  assert.match(text, /not a git work tree/, 'the reason it created neither was not reported');
});
