import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readdir, readFile, realpath, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';

import { PACKAGE_NAME } from '../src/name.mjs';
import { after, test } from 'node:test';

import { GATES, FORMATTABLE, gateNames } from '../src/hooks/gates.mjs';
import { EVENTS, HOOKS_DIR, HOOKS_PATH_KEY, fileFor, renderChainedShim, renderShim } from '../src/hooks/shim.mjs';
import { hasScript, knownGates, resolveGate, resolveStagedTool } from '../src/hooks/resolve.mjs';
import { runGates } from '../src/hooks/dispatcher.mjs';
import { packageVersion } from '../src/package-version.mjs';
import { readCapability } from '../src/hooks/capability.mjs';
import * as gateModule from '../src/projection/manifest.mjs';
import { git, cmd } from './fixture.mjs';
import { CLI } from '../src/name.mjs';
import { MANIFEST_FILE } from '../src/name.mjs';

const exec = promisify(execFile);
const BIN = new URL('../bin/simt-dev.mjs', import.meta.url).pathname;
const temps = [];

after(async () => {
  for (const t of temps) await exec('rm', ['-rf', t]);
});

async function fixture({ scripts, manifest, files = {}, binaries = [], formatter = false } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'simt-hooks-'));
  temps.push(root);
  await exec('git', ['init', '-q', '.'], { cwd: root });
  await writeFile(join(root, 'package.json'), JSON.stringify({ name: 'fx', scripts: scripts ?? {} }, null, 2));
  for (const [name, body] of Object.entries(files)) {
    const path = join(root, name);
    await mkdir(join(path, '..'), { recursive: true });
    await writeFile(path, body);
  }
  if (manifest) await writeFile(join(root, MANIFEST_FILE), JSON.stringify(manifest, null, 2));
  // `formatter: true` gives prettier a body that rewrites what it is handed, which is
  // the only shape that can show whether the hook re-staged the formatter's output -
  // an `exit 0` stub passes every assertion without exercising anything.
  const body = formatter ? '#!/bin/sh\nfor f in "$@"; do printf "FORMATTED\\n" > "$f"; done\n' : '#!/bin/sh\nexit 0\n';
  for (const b of binaries) {
    const path = join(root, 'node_modules', '.bin', b);
    await mkdir(join(path, '..'), { recursive: true });
    await writeFile(path, body);
    await chmod(path, 0o755);
  }
  return root;
}

/**
 * Put a specific blob in the index for `file` while the working tree keeps more,
 * which is what `git add -p` produces. Written as blob plumbing rather than by
 * driving `git add -p`, because an interactive prompt split differently on a
 * different git version would make this helper a second source of truth for what
 * "partially staged" means.
 */
async function stageBlob(root, file, content) {
  const scratch = join(root, '.stage-scratch');
  await writeFile(scratch, content);
  const { stdout } = await exec('git', ['hash-object', '-w', '--', scratch], { cwd: root });
  // `--add` because a fixture repo has no commit yet, so the path is not in the index
  // and git refuses to add it without being told this is intentional.
  await exec('git', ['update-index', '--add', '--cacheinfo', `100644,${stdout.trim()},${file}`], { cwd: root });
  await exec('rm', ['-f', scratch], { cwd: root });
}

async function stagedContent(root, file) {
  const { stdout } = await exec('git', ['show', `:${file}`], { cwd: root });
  return stdout;
}

async function simt(args, cwd) {
  return exec('node', [BIN, ...args], { cwd, env: { ...process.env, NO_COLOR: '1' } });
}

/**
 * The same, for a command that is expected to report a problem and exit non-zero.
 *
 * `hooks status` exits 1 on a stale shim, which is correct behaviour, and `exec`
 * turns that into a thrown error carrying the very output under test. Reading a
 * failing command's output is the whole point of the tests below.
 */
async function simtAllowingFailure(args, cwd) {
  try {
    return await simt(args, cwd);
  } catch (error) {
    return { stdout: error.stdout ?? '', stderr: error.stderr ?? '' };
  }
}

// ---------------------------------------------------------------- shim

test('shim: bakes the event name in rather than deriving it from $0', () => {
  const body = renderShim('pre-push');
  assert.match(body, /hooks run pre-push --root "\$ROOT"/);
  assert.doesNotMatch(body, /basename/);
});

test('shim: refuses an unknown event', () => {
  assert.throws(() => renderShim('post-merge'), /unknown hook event/);
});

// ---------------------------------------------------------------- chained shim

test('chained shim: runs the repository hook and forwards git arguments', async () => {
  // The whole point: core.hooksPath makes git read every hook from the shim
  // directory, so an event this tool does not gate would simply stop running. It
  // has to run the hook, and it has to forward the arguments - the dispatcher shim
  // deliberately does not, because pre-push's argv would be misread as command
  // arguments, but here the program on the other end is the repository's own hook.
  const root = await mkdtemp(join(tmpdir(), 'simt-chain-'));
  temps.push(root);
  const dir = join(root, 'hooks');
  await mkdir(dir, { recursive: true });
  const original = join(dir, 'post-commit');
  await writeFile(original, '#!/bin/sh\necho "ran with: $*"\n', { mode: 0o755 });
  await exec('git', ['init', '-q'], { cwd: root });

  const shim = join(dir, 'simt-post-commit');
  await writeFile(shim, renderChainedShim('post-commit', 'hooks/post-commit'), { mode: 0o755 });
  await exec('sh', ['-n', shim]);

  // `cwd` matters: the shim derives ROOT from git, which is the whole reason the
  // target is written relative. Run it from the repository it belongs to.
  const { stdout } = await exec('sh', [shim, 'alpha', 'beta'], { cwd: root });
  assert.match(stdout, /ran with: alpha beta/);
});

test('chained shim: a missing hook fails loudly instead of passing', async () => {
  // The gate this replacement exists to avoid: a hook that silently stops running
  // looks exactly like a hook that passed. So a chained shim whose target is gone
  // refuses, naming the file it expected.
  const root = await mkdtemp(join(tmpdir(), 'simt-chain-'));
  temps.push(root);
  await exec('git', ['init', '-q'], { cwd: root });

  const shim = join(root, 'post-commit');
  await writeFile(shim, renderChainedShim('post-commit', 'hooks/post-commit'), { mode: 0o755 });

  const result = await exec('sh', [shim], { cwd: root }).catch((e) => e);
  assert.equal(result.code, 1);
  assert.match(result.stderr, /is chained to a hook that is not there/);
});

test('chained shim: is valid POSIX sh for an event this tool does not gate', async () => {
  // `renderShim` refuses an event outside EVENTS, which is the point of the two
  // functions being separate: chaining exists precisely for those events.
  const root = await mkdtemp(join(tmpdir(), 'simt-chain-'));
  temps.push(root);
  const path = join(root, 'post-merge');
  await writeFile(path, renderChainedShim('post-merge', 'hooks/post-merge'));
  await exec('sh', ['-n', path]);
});

test('chained shim: a relative target survives the repository moving', async () => {
  // An absolute path baked in at install time stops resolving the moment anyone
  // clones or moves the repository, and the symptom is a gate that blocks every
  // commit for a reason that reads like a broken gate rather than a moved checkout.
  // The default case must be repo-relative; absolute is the linked-worktree fallback.
  assert.match(renderChainedShim('post-commit', 'hooks/post-commit'), /TARGET='hooks\/post-commit'/);
  assert.match(renderChainedShim('post-commit', 'hooks/post-commit'), /ROOT\/\$TARGET/);
});

test('shim: generated source is valid POSIX sh', async () => {
  // A shim with a syntax error fails at commit time, in the author's face, at
  // the worst possible moment. `sh -n` catches it before it ships.
  for (const event of EVENTS) {
    const path = join(await mkdtemp(join(tmpdir(), 'simt-shim-')), event);
    temps.push(join(path, '..'));
    await writeFile(path, renderShim(event));
    await exec('sh', ['-n', path]);
  }
});

test('shim: does not escape the shell variables it interpolates', async () => {
  // Regression: a template that emitted "\$ROOT" produced a literal string, so
  // the node_modules check never matched and every commit was blocked with
  // "cannot locate the dispatcher".
  const body = renderShim('pre-commit');
  assert.doesNotMatch(body, /\\\$ROOT/);
  assert.match(body, /"\$ROOT\/node_modules/);
  assert.match(body, /\$\{SIMT_DEV_BIN:-\}/);
});

test('shim: every parameter expansion carries a default', () => {
  // Regression: the "cannot locate the dispatcher" remedy echoed $SIMT_DEV_BIN
  // unguarded. The shim runs under `set -eu`, so that one line aborted the shell
  // with "SIMT_DEV_BIN: unbound variable" and the reader got an error instead of
  // the message explaining it. `sh -n` cannot catch this - the script is valid,
  // it just dies at runtime, in the one branch that only runs when nothing
  // resolved. So the guard is structural.
  for (const event of EVENTS) {
    const body = renderShim(event);
    const names = [...body.matchAll(/\$\{([A-Z_][A-Z0-9_]*)\}/g)].map((m) => m[1]);
    for (const name of names) {
      assert.ok(
        body.includes(`\${${name}:-`),
        `${event}: $${name} expands without a default and dies under \`set -u\``,
      );
    }
  }
});

test('shim: SIMT_DEV_BIN naming a .mjs entry point is run through node', async () => {
  // Regression: `exec "$SIMT_DEV_BIN"` treats the whole value as one filename, so
  // the documented override could not be used from a source checkout - the normal
  // case for anyone working on simt-dev itself.
  const root = await mkdtemp(join(tmpdir(), 'simt-shim-'));
  temps.push(root);
  await writeFile(join(root, MANIFEST_FILE), JSON.stringify({ gates: { preCommit: [], prePush: [] } }));
  await mkdir(join(root, '.git'), { recursive: true });
  await exec('git', ['init', '-q', '-b', 'main'], { cwd: root });

  const path = join(root, fileFor('pre-commit'));
  await mkdir(join(path, '..'), { recursive: true });
  await writeFile(path, renderShim('pre-commit'));
  await chmod(path, 0o755);

  const { stdout } = await exec('sh', [path], {
    cwd: root,
    env: { ...process.env, SIMT_DEV_BIN: BIN, PATH: process.env.PATH },
  });
  assert.match(stdout, /^hooks\s+pre-commit/m);
});

test('shim: SIMT_DEV_BIN naming a command line is refused, not half-executed', async () => {
  // There is no safe way to split a command line in sh without eval. Guessing
  // would run the wrong program; refusing says exactly what to set instead.
  const root = await mkdtemp(join(tmpdir(), 'simt-shim-'));
  temps.push(root);
  await mkdir(join(root, '.git'), { recursive: true });
  await exec('git', ['init', '-q', '-b', 'main'], { cwd: root });

  const path = join(root, fileFor('pre-commit'));
  await mkdir(join(path, '..'), { recursive: true });
  await writeFile(path, renderShim('pre-commit'));
  await chmod(path, 0o755);

  const result = await exec('sh', [path], {
    cwd: root,
    // PATH stays intact: emptying it makes `sh` itself unresolvable, so execFile
    // never runs the script at all. The refusal happens before any PATH lookup.
    env: { ...process.env, SIMT_DEV_BIN: `node ${BIN}` },
  }).catch((error) => ({ stderr: error.stderr, code: error.code }));

  assert.match(result.stderr, /names a command line, not a program/);
  assert.equal(result.code, 1);
});

test('shim: does not forward git arguments into argv', () => {
  // pre-push passes a remote name and URL; forwarding them would make argv
  // read them as command arguments.
  assert.doesNotMatch(renderShim('pre-push'), /run "\$@"/);
});

test('shim: every resolution path has a remedy and exits non-zero', () => {
  const body = renderShim('pre-commit');
  assert.match(body, /REMEDY/);
  assert.match(body, /exit 1/);
  assert.match(body, /cannot locate the dispatcher/);
});

test('shim: fileFor places both events in one directory', () => {
  assert.equal(fileFor('pre-commit'), `${HOOKS_DIR}/pre-commit`);
  assert.equal(fileFor('pre-push'), `${HOOKS_DIR}/pre-push`);
});

// ---------------------------------------------------------------- gates

test('gates: every gate declares a kind, an ADR and a reason', () => {
  for (const gate of Object.values(GATES)) {
    assert.ok(['staged', 'script', 'command'].includes(gate.kind), `${gate.name} kind`);
    assert.match(gate.adr, /^ADR-\d{3}$/, `${gate.name} adr`);
    assert.ok(gate.why.length > 20, `${gate.name} why`);
  }
});

test('gates: format is staged and the rest are script or command', () => {
  assert.equal(GATES.format.kind, 'staged');
  assert.equal(GATES.lint.kind, 'script');
  assert.equal(GATES.memory.kind, 'command');
});

test('gates: known gate names are sorted and include the manifest defaults', () => {
  const names = knownGates();
  assert.deepEqual(names, [...names].sort());
  for (const n of ['format', 'lint', 'test', 'coverage', 'typecheck', 'memory', 'codegen-drift', 'i18n-completeness']) {
    assert.ok(names.includes(n), `missing ${n}`);
  }
});

// ---------------------------------------------------------------- resolve

test('resolve: hasScript only accepts a non-empty string', () => {
  const pkg = { scripts: { a: 'x', b: '' } };
  assert.equal(hasScript(pkg, 'a'), true);
  assert.equal(hasScript(pkg, 'b'), false);
  assert.equal(hasScript(pkg, 'missing'), false);
  assert.equal(hasScript(null, 'a'), false);
});

test('resolve: staged gate finds the binary in the project node_modules', async () => {
  const root = await fixture({ binaries: ['prettier'] });
  const tool = await resolveStagedTool(root, GATES.format);
  assert.equal(tool.tool, 'prettier');
  assert.match(tool.path, /node_modules\/\.bin\/prettier$/);
});

test('resolve: staged gate reports exactly what it looked for when absent', async () => {
  const root = await fixture({});
  const tool = await resolveStagedTool(root, GATES.format);
  assert.equal(tool.path, null);
  assert.equal(tool.tried.length, 1);
});

test('resolve: staged gate only receives files it can format', async () => {
  const root = await fixture({ binaries: ['prettier'] });
  const result = await resolveGate(GATES.format, {
    root,
    pkg: null,
    staged: ['src/a.ts', 'docs/b.md', 'logo.png', 'Makefile'],
    commands: {},
  });
  assert.equal(result.ok, true);
  assert.deepEqual(result.argv.slice(2), ['src/a.ts', 'docs/b.md']);
});

test('resolve: staged gate is a pass with nothing to do, not a failure', async () => {
  const root = await fixture({ binaries: ['prettier'] });
  const result = await resolveGate(GATES.format, {
    root, pkg: null, staged: ['logo.png'], commands: {},
  });
  assert.equal(result.ok, true);
  assert.equal(result.argv, null);
});

test('resolve: a gate that cannot run fails with a remedy, never silently passes', async () => {
  const cases = [
    [GATES.format, {}, 'no formatter binary in node_modules/.bin', 'remove "format"'],
    [GATES.lint, {}, 'package.json declares no "lint" script', 'add "lint" to scripts'],
    [GATES.memory, {}, 'no command declared', 'gates.commands["memory"]'],
  ];
  for (const [gate, ctx, reasonFragment, remedyFragment] of cases) {
    const root = await fixture({});
    const result = await resolveGate(gate, { root, pkg: ctx.pkg ?? null, staged: [], commands: ctx.commands });
    assert.equal(result.ok, false, `${gate.name} should fail`);
    assert.ok(result.reason.includes(reasonFragment), `${gate.name} reason: ${result.reason}`);
    assert.ok(result.remedy.includes(remedyFragment), `${gate.name} remedy: ${result.remedy}`);
  }
});

test('resolve: script gates go through npm run, never npx (ADR-010)', async () => {
  const root = await fixture({ scripts: { lint: 'true' } });
  const result = await resolveGate(GATES.lint, { root, pkg: { scripts: { lint: 'true' } }, staged: [], commands: {} });
  assert.deepEqual(result.argv, ['npm', 'run', '--silent', 'lint']);
  assert.doesNotMatch(result.argv.join(' '), /npx|npm exec/);
});

test('resolve: a command gate uses the manifest command verbatim', async () => {
  const root = await fixture({});
  const result = await resolveGate(GATES.memory, {
    root, pkg: null, staged: [], commands: { memory: './bin/memcheck.sh' },
  });
  assert.deepEqual(result.argv, ['./bin/memcheck.sh']);
});

test('resolve: a declared command wins for a script gate, which is how a Gradle repo gates', async () => {
  // simt-app is the first adopter with a Gradle runner: no `test` npm script exists and
  // never will, so the repo declares `test: ./gradlew check`. Before this, the dispatcher
  // demanded the npm script while `check` and the drop remedy both said to name the
  // command — three surfaces, one manifest, two different answers.
  const root = await fixture({});
  const result = await resolveGate(GATES.test, {
    root, pkg: { scripts: {} }, staged: [], commands: { test: './gradlew check' },
  });
  assert.equal(result.ok, true);
  assert.deepEqual(result.argv, ['./gradlew', 'check']);
  assert.match(result.detail, /declared command/);
});

test('resolve: a declared command also overrides a staged formatter', async () => {
  const root = await fixture({});
  const result = await resolveGate(GATES.format, {
    root, pkg: null, staged: ['a.ts'], commands: { format: './gradlew spotlessApply' },
  });
  assert.equal(result.ok, true);
  assert.deepEqual(result.argv, ['./gradlew', 'spotlessApply']);
});

test('resolve: an empty declared command is a failure, not a silent pass', async () => {
  // An empty command would otherwise resolve to argv `[]` and "run nothing", which is a
  // gate that reports PASSED while proving nothing.
  const root = await fixture({});
  const result = await resolveGate(GATES.test, {
    root, pkg: { scripts: { test: 'true' } }, staged: [], commands: { test: '   ' },
  });
  assert.equal(result.ok, false);
  assert.match(result.reason, /is empty/);
});

test('resolve, check and status agree on what a declared command does', async () => {
  // The defect in one assertion: the dispatcher ran the declared command and passed
  // while `check` reported the same gate unrunnable, because each read `gates.commands`
  // differently. One manifest, one answer.
  const root = await fixture({});
  await writeFile(join(root, MANIFEST_FILE), JSON.stringify({ gates: { prePush: ['test'], commands: { test: './gradlew check' } } }));
  const capability = await readCapability(root);
  assert.equal(capability.commands.test, './gradlew check');

  const resolved = await resolveGate(GATES.test, {
    root, pkg: { scripts: {} }, staged: [], commands: capability.commands,
  });
  assert.equal(resolved.ok, true);

  const declared = { gates: { preCommit: [], prePush: ['test'] } };
  assert.deepEqual(gateModule.unrunnableGates(declared, capability), []);
});

test('resolve: formattable extensions include what the estate actually uses', () => {
  for (const ext of ['.ts', '.tsx', '.json', '.md', '.less', '.yml']) {
    assert.ok(FORMATTABLE.has(ext), `missing ${ext}`);
  }
  assert.equal(FORMATTABLE.has('.png'), false);
  assert.equal(FORMATTABLE.has('.tif'), false);
});

// ---------------------------------------------------------------- dispatcher

test('dispatcher: an unresolvable gate blocks the event', async () => {
  const root = await fixture({ scripts: {}, manifest: { gates: { preCommit: ['format'], prePush: [] } } });
  const result = await runGates('pre-commit', { root, manifest: { gates: { preCommit: ['format'], prePush: [] } } });
  assert.equal(result.failed, true);
  assert.equal(result.gates[0].status, 'failed');
  assert.ok(result.gates[0].remedy);
});

test('dispatcher: an unknown gate blocks rather than being skipped', async () => {
  const manifest = { gates: { preCommit: ['format', 'made-up-gate'], prePush: [] } };
  const root = await fixture({ manifest });
  const result = await runGates('pre-commit', { root, manifest });
  const bad = result.gates.find((g) => g.name === 'made-up-gate');
  assert.equal(bad.status, 'failed');
  assert.match(bad.detail, /unknown gate/);
  assert.equal(result.failed, true);
});

test('dispatcher: a failing script gate fails the event and reports the output', async () => {
  const manifest = { gates: { preCommit: ['lint'], prePush: [] } };
  const root = await fixture({ scripts: { lint: 'echo BOOM; exit 3' }, manifest });
  const pkg = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
  const result = await runGates('pre-commit', {
    root,
    manifest: { ...manifest, gates: { ...manifest.gates, preCommit: ['lint'] } },
  });
  const gate = result.gates.find((g) => g.name === 'lint');
  assert.equal(gate.status, 'failed');
  assert.match(gate.detail, /exit 3/);
  assert.ok(pkg.scripts.lint);
});

test('dispatcher: an empty gate list passes but says why', async () => {
  const root = await fixture({ manifest: { gates: { preCommit: [], prePush: [] } } });
  const result = await runGates('pre-commit', { root, manifest: { gates: { preCommit: [], prePush: [] } } });
  assert.equal(result.failed, false);
  assert.match(result.notes[0], /declares no gates\.preCommit/);
});

test('dispatcher: pre-push reads gates.prePush, not preCommit', async () => {
  const manifest = { gates: { preCommit: ['lint'], prePush: ['test'] } };
  const root = await fixture({ scripts: { test: 'exit 0' }, manifest });
  const result = await runGates('pre-push', { root, manifest });
  assert.deepEqual(result.gates.map((g) => g.name), ['test']);
});

test('dispatcher: an unknown event fails rather than passing silently', async () => {
  const root = await fixture({});
  const result = await runGates('post-merge', { root, manifest: { gates: {} } });
  assert.equal(result.failed, true);
  assert.match(result.error, /unknown hook event/);
});

test('dispatcher: a stale pin fails the event with a version gate', async () => {
  // S35: for a repository without npm the gates run from a global install, whose version
  // nothing else pins. The pin in the manifest is the only thing that knows which version
  // it should be, so a mismatch fails the event before any gate runs.
  const root = await fixture({ manifest: { gates: { preCommit: ['format'], prePush: [] } } });
  const stale = `${packageVersion()}-x`;
  const result = await runGates('pre-commit', {
    root,
    manifest: { gates: { preCommit: ['format'], prePush: [] }, projection: { version: stale } },
  });
  assert.equal(result.failed, true);
  const gate = result.gates.find((g) => g.name === 'version');
  assert.equal(gate.status, 'failed');
  assert.match(gate.detail, /version mismatch/);
  assert.match(gate.remedy, /upgrade/);
});

test('dispatcher: a matching pin is not a version gate', async () => {
  // The guard exists to catch a stale binary, not to re-check one that matches: on a
  // match the event proceeds to the gates it actually declared.
  const root = await fixture({ scripts: { lint: 'echo ok' }, manifest: { gates: { preCommit: ['lint'], prePush: [] } } });
  const result = await runGates('pre-commit', {
    root,
    manifest: { gates: { preCommit: ['lint'], prePush: [] }, projection: { version: packageVersion() } },
  });
  assert.ok(!result.gates.some((g) => g.name === 'version'), 'the version gate is only inserted on a mismatch');
  assert.equal(result.gates.find((g) => g.name === 'lint').status, 'passed');
});

test('dispatcher: a stale pin does not block an event that declares no gates', async () => {
  // The version check is placed after the empty-list check on purpose: a repository that
  // declares no gates has nothing the version could get wrong, and failing it would block
  // commits in repos that deliberately declare none.
  const root = await fixture({ manifest: { gates: { preCommit: [], prePush: [] } } });
  const result = await runGates('pre-commit', {
    root,
    manifest: { gates: { preCommit: [], prePush: [] }, projection: { version: `${packageVersion()}-x` } },
  });
  assert.equal(result.failed, false);
  assert.ok(!result.gates.some((g) => g.name === 'version'));
});

// ---------------------------------------------------------------- restage (S08)
//
// The hook formats the WORKING TREE copy of what it is handed and then re-stages.
// Two things go wrong if nobody checks, and both are silent:
//
//   1. A file staged with `git add -p` also carries unstaged hunks. Formatting it
//      rewrites those too and the restage commits them - ADR-004's exact
//      prohibition, on the path that runs on every commit in every adopted repo.
//   2. A staged deletion makes `git add` fail, and a failed add that is caught and
//      dropped leaves the commit holding unformatted bytes while the hook says it
//      passed.

test('dispatcher: a partially staged file is refused, and its unstaged hunk survives', async () => {
  const manifest = { gates: { preCommit: ['format'], prePush: [] } };
  const root = await fixture({ manifest, binaries: ['prettier'], formatter: true });
  await exec('git', ['add', '-A'], { cwd: root });
  await stageBlob(root, 'a.md', 'one\nSTAGED\n');
  await writeFile(join(root, 'a.md'), 'one\nSTAGED\nUNSTAGED-WORK\n');

  const result = await runGates('pre-commit', { root, manifest });

  assert.equal(result.failed, true, 'a partial stage must block the commit, not be guessed at');
  const gate = result.gates.find((g) => g.name === 'format');
  assert.equal(gate.status, 'failed');
  assert.match(gate.detail, /unstaged changes/);
  assert.match(gate.detail, /a\.md/, 'the remedy has to name the file the author must act on');
  assert.ok(gate.remedy, 'every failure mode carries a remedy (ADR-010)');
  // The whole point: neither the index nor the working tree lost the author's work.
  assert.equal(await stagedContent(root, 'a.md'), 'one\nSTAGED\n');
  assert.equal(await readFile(join(root, 'a.md'), 'utf8'), 'one\nSTAGED\nUNSTAGED-WORK\n');
});

test('dispatcher: a staged deletion does not break restaging the file that is still there', async () => {
  const manifest = { gates: { preCommit: ['format'], prePush: [] } };
  const root = await fixture({
    manifest,
    binaries: ['prettier'],
    formatter: true,
    files: { 'doomed.md': 'doomed\n', 'keep.md': 'keep\n' },
  });
  await exec('git', ['add', '-A'], { cwd: root });
  await git(['commit', '-qm', 'base'], { cwd: root });
  await exec('git', ['rm', '-q', 'doomed.md'], { cwd: root });
  await writeFile(join(root, 'keep.md'), 'keep\nEXTRA\n');
  await exec('git', ['add', 'keep.md'], { cwd: root });

  const result = await runGates('pre-commit', { root, manifest });

  assert.equal(result.failed, false);
  const restage = result.gates.find((g) => g.name === 'restage');
  assert.ok(restage, 'the commit would otherwise record unformatted bytes and say nothing');
  assert.equal(restage.status, 'passed');
  assert.match(restage.detail, /keep\.md/);
  // The formatted bytes are what the commit records, and the deletion is untouched.
  assert.equal(await stagedContent(root, 'keep.md'), 'FORMATTED\n');
  const staged = await exec('git', ['diff', '--cached', '--name-only'], { cwd: root });
  assert.match(staged.stdout, /doomed\.md/, 'the deletion is still staged');
});

test('dispatcher: restage says nothing when the formatter changed no bytes', async () => {
  // A no-op formatter passes every other assertion in this file, so a restage line
  // printed on its say-so would be a report nobody could trust.
  const manifest = { gates: { preCommit: ['format'], prePush: [] } };
  const root = await fixture({ manifest, binaries: ['prettier'], files: { 'a.md': 'one\n' } });
  await exec('git', ['add', '-A'], { cwd: root });
  await git(['commit', '-qm', 'base'], { cwd: root });
  await writeFile(join(root, 'a.md'), 'dirty\n');
  await exec('git', ['add', 'a.md'], { cwd: root });

  const result = await runGates('pre-commit', { root, manifest });

  assert.equal(result.failed, false);
  assert.deepEqual(result.gates.map((g) => g.name), ['format'], 'restage reported a change that did not happen');
});

test('dispatcher: restage touches only the files the formatter was given', async () => {
  // Two staged files, but only one is formattable. `git add` on the other would
  // stage whatever the working tree happened to hold since it was staged.
  const manifest = { gates: { preCommit: ['format'], prePush: [] } };
  const root = await fixture({
    manifest,
    binaries: ['prettier'],
    formatter: true,
    files: { 'a.md': 'one\n', 'blob.bin': 'base\n' },
  });
  await exec('git', ['add', '-A'], { cwd: root });
  await git(['commit', '-qm', 'base'], { cwd: root });
  await writeFile(join(root, 'a.md'), 'one\nstaged\n');
  await writeFile(join(root, 'blob.bin'), 'base\nstaged\n');
  await exec('git', ['add', '-A'], { cwd: root });
  // Unstaged edit to the file no gate formats; it must survive the hook untouched.
  await writeFile(join(root, 'blob.bin'), 'base\nstaged\nworking-only\n');

  const result = await runGates('pre-commit', { root, manifest });

  assert.equal(result.failed, false);
  assert.equal(await stagedContent(root, 'a.md'), 'FORMATTED\n');
  assert.equal(
    await stagedContent(root, 'blob.bin'),
    'base\nstaged\n',
    'a file the formatter never saw was re-staged from the working tree',
  );
});

test('dispatcher: a declared format command is guarded too, because its targets are unknown', async () => {
  // `gates.commands.format` is an arbitrary command line. Nothing here can know
  // which paths it will open, so every staged file with unstaged changes is at risk
  // and the guard has to hold for all of them rather than assume argv holds paths.
  const manifest = {
    gates: { preCommit: ['format'], prePush: [], commands: { format: 'sh -c true' } },
  };
  const root = await fixture({ manifest, binaries: ['prettier'], formatter: true });
  await exec('git', ['add', '-A'], { cwd: root });
  await stageBlob(root, 'a.md', 'one\nSTAGED\n');
  await writeFile(join(root, 'a.md'), 'one\nSTAGED\nUNSTAGED-WORK\n');

  const result = await runGates('pre-commit', { root, manifest });

  assert.equal(result.failed, true);
  const gate = result.gates.find((g) => g.name === 'format');
  assert.equal(gate.status, 'failed');
  assert.match(gate.detail, /unstaged changes/);
  assert.equal(await stagedContent(root, 'a.md'), 'one\nSTAGED\n');
});

// ---------------------------------------------------------------- install / status

test('hooks install: writes both shims, sets core.hooksPath, and is idempotent', async () => {
  const root = await fixture({ manifest: { gates: { preCommit: ['lint'], prePush: ['test'] } } });
  await simt(['init', '--root', root, '--yes'], root).catch(() => {});
  await simt(['hooks', 'install', '--root', root, '--yes'], root);

  for (const event of EVENTS) {
    const body = await readFile(join(root, fileFor(event)), 'utf8');
    assert.equal(body, renderShim(event));
  }
  const { stdout } = await exec('git', ['config', '--get', HOOKS_PATH_KEY], { cwd: root });
  assert.equal(stdout.trim(), HOOKS_DIR);

  const again = await simt(['hooks', 'install', '--root', root, '--yes'], root);
  assert.match(again.stdout, /UNCHANGED/);
});

test('hooks install: refuses to take over an existing hooks path without --yes', async () => {
  const root = await fixture({ manifest: { gates: { preCommit: [], prePush: [] } } });
  await exec('git', ['config', HOOKS_PATH_KEY, 'scripts/git-hooks'], { cwd: root });

  await assert.rejects(
    () => simt(['hooks', 'install', '--root', root], root),
    (error) => error.code === 1 && /BLOCKED/.test(error.stdout + error.stderr),
  );
  const { stdout } = await exec('git', ['config', '--get', HOOKS_PATH_KEY], { cwd: root });
  assert.equal(stdout.trim(), 'scripts/git-hooks', 'must not have taken over');
});

test('hooks install: dry-run writes nothing', async () => {
  const root = await fixture({ manifest: { gates: { preCommit: ['lint'], prePush: [] } } });
  await simt(['hooks', 'install', '--root', root, '--dry-run'], root);
  await assert.rejects(() => readFile(join(root, fileFor('pre-commit')), 'utf8'));
});

test('hooks install: without --yes it prints the plan and the command that applies it', async () => {
  // ADR-040. `hooks install` used to read `flags.yes` and `flags.dryRun` directly
  // and write when neither said otherwise, so it was the last writer still writing
  // by default after ADR-035 and ADR-036. A preview that does not name the command
  // that applies it is only half the fix: the reader is left holding a plan with no
  // next step, which is how `sync`'s preview had to be written too.
  const root = await fixture({ manifest: { gates: { preCommit: ['lint'], prePush: ['test'] } } });

  const { stdout } = await simt(['hooks', 'install', '--root', root], root);
  assert.match(stdout, /PLAN\s+nothing written/, stdout);
  assert.match(stdout, new RegExp(`${CLI} hooks install --root .*--yes`), stdout);
  assert.doesNotMatch(stdout, /WROTE/, 'a preview that claims to have written is lying about what it did');
  await assert.rejects(() => readFile(join(root, fileFor('pre-commit')), 'utf8'));

  // And the plan it printed is the plan `--yes` carries out, or the preview is a
  // different claim from the write rather than a rehearsal of it.
  const applied = await simt(['hooks', 'install', '--root', root, '--yes'], root);
  assert.equal(applied.stdout.match(/CREATED/g).length, stdout.match(/CREATED/g).length);
  assert.match(await readFile(join(root, fileFor('pre-commit')), 'utf8'), /Generated by simt-dev/);
});

test('hooks install: a bare re-run of an installed repo writes nothing and is not a takeover', async () => {
  // The shape an operator actually hits: run it, then run it again to see. The
  // second run is not a takeover - `core.hooksPath` already points at the shims -
  // so it must reach the preview rather than the BLOCKED refusal ADR-018 requires.
  // Reaching either one by accident would teach the reader that `--yes` is needed
  // for a no-op, and then they would pass it for everything.
  const root = await fixture({ manifest: { gates: { preCommit: ['lint'], prePush: [] } } });
  await simt(['hooks', 'install', '--root', root, '--yes'], root);
  const before = await readFile(join(root, fileFor('pre-commit')), 'utf8');

  const { stdout } = await simt(['hooks', 'install', '--root', root], root);
  assert.doesNotMatch(stdout, /BLOCKED/, 'an idempotent re-run is not a takeover');
  assert.match(stdout, /UNCHANGED/);
  assert.equal(await readFile(join(root, fileFor('pre-commit')), 'utf8'), before);
});

test('hooks install: needs a manifest, because gates must be declared', async () => {
  const root = await fixture({});
  await assert.rejects(
    () => simt(['hooks', 'install', '--root', root, '--yes'], root),
    (error) => error.code === 3,
  );
});

test('hooks status: exits non-zero and names every problem', async () => {
  const root = await fixture({});
  await assert.rejects(
    () => simt(['hooks', 'status', '--root', root], root),
    (error) => {
      assert.equal(error.code, 1);
      const out = error.stdout + error.stderr;
      assert.match(out, cmd('{manifest} MISSING'));
      assert.match(out, /core\.hooksPath is \(unset\)/);
      assert.match(out, /pre-commit not installed/);
      return true;
    },
  );
});

test('hooks status: is clean and exits 0 once installed', async () => {
  const root = await fixture({ manifest: { gates: { preCommit: ['lint'], prePush: ['test'] } } });
  await simt(['hooks', 'install', '--root', root, '--yes'], root);
  const { stdout } = await simt(['hooks', 'status', '--root', root], root);
  assert.match(stdout, /\(simt-dev\)/);
  assert.match(stdout, /run script  \[ADR-004\]/);
  assert.doesNotMatch(stdout, /problems:/);
});

test('hooks status: flags a gate the dispatcher cannot run', async () => {
  const root = await fixture({
    manifest: { gates: { preCommit: ['memory'], prePush: [], commands: {} } },
  });
  await simt(['hooks', 'install', '--root', root, '--yes'], root);
  await assert.rejects(
    () => simt(['hooks', 'status', '--root', root], root),
    (error) => /command gate with no declared command/.test(error.stdout + error.stderr),
  );
});

test('hooks status: flags a declared command that no gate uses', async () => {
  const root = await fixture({
    manifest: { gates: { preCommit: ['lint'], prePush: [], commands: { memory: './x.sh' } } },
  });
  await simt(['hooks', 'install', '--root', root, '--yes'], root);
  const { stdout } = await simt(['hooks', 'status', '--root', root], root);
  assert.match(stdout, /declared but never run: memory/);
});

test('hooks run: refuses without a manifest instead of reporting success', async () => {
  const root = await fixture({});
  await assert.rejects(
    () => simt(['hooks', 'run', 'pre-commit', '--root', root], root),
    (error) => error.code === 3 && /cannot know its gate list/.test(error.stderr),
  );
});

test('hooks run: blocks on an unresolvable gate, so --no-verify is not the next step', async () => {
  const root = await fixture({ manifest: { gates: { preCommit: ['format'], prePush: [] } } });
  await assert.rejects(
    () => simt(['hooks', 'run', 'pre-commit', '--root', root], root),
    (error) => {
      assert.equal(error.code, 1);
      assert.match(error.stdout, /BLOCKED/);
      assert.match(error.stdout, /remedy:/);
      return true;
    },
  );
});

test('hooks run: --json reports the same verdict machine-readably', async () => {
  const root = await fixture({ scripts: { lint: 'exit 0' }, manifest: { gates: { preCommit: ['lint'], prePush: [] } } });
  const { stdout } = await simt(['hooks', 'run', 'pre-commit', '--root', root, '--json'], root);
  const payload = JSON.parse(stdout);
  assert.equal(payload.ok, true);
  assert.equal(payload.gates[0].status, 'passed');
});

test('a real git commit is blocked by a gate that cannot run', async () => {
  // The end-to-end claim: the shim is reachable from git, not only from the CLI.
  const root = await fixture({ manifest: { gates: { preCommit: ['format'], prePush: [] } } });
  // An initial commit first: an unborn branch would make `git log` itself fail,
  // so the assertion below could not distinguish "blocked" from "never ran".
  await writeFile(join(root, 'seed.txt'), 'seed\n');
  await exec('git', ['add', '-A'], { cwd: root });
  await git(['commit', '-q', '-m', 'seed', '--no-verify'], { cwd: root });
  await simt(['init', '--root', root, '--yes'], root).catch(() => {});
  await simt(['hooks', 'install', '--root', root, '--yes'], root);
  // Create the PARENT of the installed package, not the package itself: ln -sfn onto
  // an existing directory nests the link inside it, and the shim then finds nothing.
  const installed = join(root, 'node_modules', ...PACKAGE_NAME.split('/'));
  await mkdir(dirname(installed), { recursive: true });
  await exec('ln', ['-sfn', new URL('..', import.meta.url).pathname, installed]);
  await writeFile(join(root, '.gitignore'), 'node_modules\n');
  await writeFile(join(root, 'a.ts'), 'x\n');
  await exec('git', ['add', '-A'], { cwd: root });

  await assert.rejects(
    () => git(['commit', '-m', 'should be blocked'], { cwd: root }),
    (error) => {
      const out = `${error.stdout}${error.stderr}`;
      assert.match(out, /no formatter binary in node_modules\/\.bin/);
      assert.doesNotMatch(out, /created commit|\[simt-dev\/adopt /);
      return true;
    },
  );
  const { stdout } = await exec('git', ['log', '--oneline'], { cwd: root });
  assert.equal(stdout.trim().split('\n').length, 1, 'only the seed commit may exist');
});

test('gateNames matches knownGates', () => {
  assert.deepEqual(gateNames(), knownGates());
});
test('hooks run: an empty gate list prints one note, not one line per character', async () => {
  // The note sat next to `gates` as a bare string while the caller iterated it, so a
  // string iterated character by character: 180 lines of noise from a hook whose only
  // job is to be readable. Found by running `hooks run` on the first repo that
  // legitimately has no pre-commit gate.
  const { runGates } = await import('../src/hooks/dispatcher.mjs');
  const result = await runGates('pre-commit', { root: '/nonexistent', manifest: { gates: { preCommit: [] } } });
  assert.equal(result.failed, false);
  assert.ok(Array.isArray(result.notes), 'notes must be an array, not a string');
  assert.equal(result.notes.length, 1);
  assert.equal(result.gates.length, 0);
});

test('hooks run: the empty-gate note explains the two readings, not just one', async () => {
  const { runGates } = await import('../src/hooks/dispatcher.mjs');
  const { notes } = await runGates('pre-push', { root: '/nonexistent', manifest: { gates: { prePush: [] } } });
  // The note must not read as "you forgot something": a repo with no formatter and no
  // linter has no pre-commit gate, and that is a correct manifest.
  assert.match(notes[0], /valid answer/);
  assert.match(notes[0], /no tool/);
  assert.ok(!/accident/i.test(notes[0]), 'the old wording implied the empty list was a mistake');
});

// ------------------------------------------------- foreign hooks (where.mjs)
// simt-space keeps 4 KB of real logic in .git/hooks/pre-commit with
// core.hooksPath UNSET. Unset means "git uses its default", not "git runs
// nothing", and reading it the other way made `hooks status` report a live hook
// as not installed and let `install` replace it without a word.

test('where: an unset core.hooksPath resolves to the git default, not to nothing', async () => {
  const { resolveHooksDir } = await import('../src/hooks/where.mjs');
  const root = await fixture({});
  const where = await resolveHooksDir(root);
  assert.equal(where.how, 'default');
  // git reports the top level through /private/var, mkdtemp hands back /var.
  assert.equal(where.dir, join(await realpath(root), '.git', 'hooks'));
});

test('where: a relative core.hooksPath resolves against the top of the working tree', async () => {
  // simt-app sets exactly this, and it works because git resolves a relative
  // hooks path against the worktree top, not against the git dir.
  const { resolveHooksDir } = await import('../src/hooks/where.mjs');
  const root = await fixture({ files: { 'hooks/pre-commit': '#!/bin/sh\nexit 0\n' } });
  await chmod(join(root, 'hooks', 'pre-commit'), 0o755);
  await exec('git', ['config', HOOKS_PATH_KEY, 'hooks'], { cwd: root });
  const where = await resolveHooksDir(root);
  assert.equal(where.how, 'configured');
  assert.equal(where.dir, join(await realpath(root), 'hooks'));
});

test('where: a linked worktree shares its parent hooks directory', async () => {
  // The worktree's git dir is not the parent repo's .git, and its own .git is a
  // FILE. `--git-path hooks` returns "./" here, which would enumerate the whole
  // repository as if every file in it were a hook.
  const { resolveHooksDir, foreignHooks } = await import('../src/hooks/where.mjs');
  const main = await fixture({});
  await writeFile(join(main, 'a.txt'), 'a\n');
  await exec('git', ['add', '.'], { cwd: main });
  await git(['commit', '-qm', 'seed'], { cwd: main });

  const links = await mkdtemp(join(tmpdir(), 'simt-wt-'));
  temps.push(links);
  const wt = join(links, 'wt');
  await exec('git', ['worktree', 'add', '-q', wt], { cwd: main });

  const where = await resolveHooksDir(wt);
  assert.equal(where.how, 'default');
  assert.equal(where.dir, join(await realpath(main), '.git', 'hooks'));

  // A hook installed in the parent is a hook the worktree runs, and simt-dev
  // has to be able to see it.
  await writeFile(join(main, '.git', 'hooks', 'pre-commit'), '#!/bin/sh\nexit 0\n');
  await chmod(join(main, '.git', 'hooks', 'pre-commit'), 0o755);
  const live = await foreignHooks(wt);
  assert.equal(live.length, 1);
  assert.equal(live[0].event, 'pre-commit');
  assert.equal(live[0].path, join(await realpath(main), '.git', 'hooks', 'pre-commit'));
});

test('where: git sample templates are not hooks', async () => {
  const { foreignHooks } = await import('../src/hooks/where.mjs');
  const root = await fixture({});
  const gitHooks = join(root, '.git', 'hooks');
  for (const name of ['pre-commit.sample', 'pre-push.sample', 'update.sample']) {
    await writeFile(join(gitHooks, name), '#!/bin/sh\nexit 0\n');
    await chmod(join(gitHooks, name), 0o755);
  }
  assert.deepEqual(await foreignHooks(root), []);
});

test('hooks status: reports a hand-written hook git is running as foreign', async () => {
  const root = await fixture({
    manifest: { gates: { preCommit: ['lint'], prePush: [] }, commands: {} },
    scripts: { lint: 'true' },
    files: { '.git/hooks/pre-commit': '#!/bin/sh\n# 4088 bytes of real logic in the real world\necho hand-written\n' },
  });
  await chmod(join(root, '.git', 'hooks', 'pre-commit'), 0o755);
  // A foreign hook is a problem, so status exits non-zero and exec rejects.
  const { stdout } = await simt(['hooks', 'status', '--root', root], root).catch((e) => e);
  assert.match(stdout, /git runs these, and simt-dev did not write them/);
  assert.match(stdout, /pre-commit\s+.*\.git\/hooks\/pre-commit/);
  assert.match(stdout, /which is not a simt-dev shim/);
  // The header must not claim there are no hooks while listing one.
  assert.doesNotMatch(stdout, /\(none\)/);
  assert.match(stdout, /git default: .*\.git\/hooks/);
});

test('hooks install: refuses to replace a hand-written hook and writes nothing', async () => {
  const root = await fixture({
    manifest: { gates: { preCommit: ['lint'], prePush: [] }, commands: {} },
    scripts: { lint: 'true' },
    files: { '.git/hooks/pre-commit': '#!/bin/sh\necho hand-written\n' },
  });
  await chmod(join(root, '.git', 'hooks', 'pre-commit'), 0o755);
  await assert.rejects(
    () => simt(['hooks', 'install', '--root', root], root),
    (error) => {
      assert.equal(error.code, 1);
      assert.match(error.stdout, new RegExp(`BLOCKED .* already runs git hooks that ${CLI} did not write`));
      assert.match(error.stdout, /git runs pre-commit at/);
      return true;
    },
  );
  const { stdout } = await exec('git', ['config', '--get', HOOKS_PATH_KEY], { cwd: root }).catch(() => ({ stdout: '' }));
  assert.equal(stdout.trim(), '', 'core.hooksPath must still be unset');
  // And the hook git runs is untouched.
  assert.match(await readFile(join(root, '.git', 'hooks', 'pre-commit'), 'utf8'), /hand-written/);
});

test('hooks install --yes: replaces it and says which hook stopped running', async () => {
  const root = await fixture({
    manifest: { gates: { preCommit: ['lint'], prePush: [] }, commands: {} },
    scripts: { lint: 'true' },
    files: { '.git/hooks/pre-commit': '#!/bin/sh\necho hand-written\n' },
  });
  await chmod(join(root, '.git', 'hooks', 'pre-commit'), 0o755);
  const { stderr } = await simt(['hooks', 'install', '--root', root, '--yes'], root);
  assert.match(stderr, /stopped running pre-commit at .*\.git\/hooks\/pre-commit \(\d+ bytes\)/);
  assert.match(stderr, /still on disk, untouched/);
});

test('hooks install --yes: chains a foreign hook on an event this tool does not gate', async () => {
  // The defect this closes, end to end. `core.hooksPath` does not scope routing to
  // the events this tool gates: git reads every hook from the named directory. So
  // without chaining, adopting this repository silently stops its `post-commit` -
  // no error, no log, hook still on disk looking intact.
  const root = await fixture({
    manifest: { gates: { preCommit: ['lint'], prePush: [] }, commands: {} },
    scripts: { lint: 'true' },
    files: { '.git/hooks/post-commit': '#!/bin/sh\nexit 0\n' },
  });
  await chmod(join(root, '.git', 'hooks', 'post-commit'), 0o755);

  const { stderr } = await simt(['hooks', 'install', '--root', root, '--yes'], root);

  // The note has to say it was CHAINED. The old note said "stopped running" about
  // every foreign hook, which is false here and would send an operator to restore a
  // hook that install is already running for them.
  assert.match(stderr, /chained post-commit/);
  assert.doesNotMatch(stderr, /stopped running post-commit/);

  // And the shim has to exist, run the original hook, and say so in the plan.
  const shim = await readFile(join(root, HOOKS_DIR, 'post-commit'), 'utf8');
  assert.match(shim, /post-commit/, 'the chained shim names its event');
  const { stdout } = await simt(['hooks', 'install', '--root', root], root);
  assert.match(stdout, /chained: runs \.git\/hooks\/post-commit/);
});

test('hooks install: a gate-type foreign hook is not chained, it is named as stopped', async () => {
  // The other half of ruling 7. `pre-commit` is an event this tool gates, so the
  // hook belongs in `gates.commands` where its verdict appears in the gate report;
  // chaining it would run it after the gates passed, where an author cannot see it.
  const root = await fixture({
    manifest: { gates: { preCommit: ['lint'], prePush: [] }, commands: {} },
    scripts: { lint: 'true' },
    files: { '.git/hooks/pre-commit': '#!/bin/sh\nexit 0\n' },
  });
  await chmod(join(root, '.git', 'hooks', 'pre-commit'), 0o755);
  const { stderr } = await simt(['hooks', 'install', '--root', root, '--yes'], root);
  assert.match(stderr, /stopped running pre-commit/);
  assert.match(stderr, /gates\.commands/);
});

test('hooks install: a second run leaves the chained shim unchanged', async () => {
  // Idempotency, which is where this actually broke. The chain was written on the
  // first run but read back from disk on the second, and macOS spells the same
  // directory `/var/...` and `/private/var/...` depending on who asked - so compared
  // naively the shim looked rewritten on every run and `install` rewrote an identical
  // file forever. A plan that never settles is indistinguishable from one that is
  // wrong, and this is the test that says the bytes are stable.
  const root = await fixture({
    manifest: { gates: { preCommit: ['lint'], prePush: [] }, commands: {} },
    scripts: { lint: 'true' },
    files: { '.git/hooks/post-commit': '#!/bin/sh\nexit 0\n' },
  });
  await chmod(join(root, '.git', 'hooks', 'post-commit'), 0o755);
  await simt(['hooks', 'install', '--root', root, '--yes'], root);
  const first = await readFile(join(root, HOOKS_DIR, 'post-commit'), 'utf8');

  const { stdout } = await simt(['hooks', 'install', '--root', root, '--yes'], root);
  assert.match(stdout, /UNCHANGED \.simt-hooks\/post-commit/);
  assert.equal(await readFile(join(root, HOOKS_DIR, 'post-commit'), 'utf8'), first);
});

test('hooks status: does not report this tool\'s own chained shim as a foreign hook', async () => {
  // A shim this tool wrote, refusing itself: the name is the repository's hook name,
  // so only the bytes can say whose it is. Without the marker check, every re-install
  // on a chained repo fails with "this repo already runs hooks simt did not write".
  const root = await fixture({
    manifest: { gates: { preCommit: ['lint'], prePush: [] }, commands: {} },
    scripts: { lint: 'true' },
    files: { '.git/hooks/post-commit': '#!/bin/sh\nexit 0\n' },
  });
  await chmod(join(root, '.git', 'hooks', 'post-commit'), 0o755);
  await simt(['hooks', 'install', '--root', root, '--yes'], root);

  const { stdout, stderr } = await simt(['hooks', 'status', '--root', root], root);
  assert.doesNotMatch(stdout + stderr, /git runs post-commit/);
});

test('hooks install: chains a foreign hook on a gated event this repo declares no gate for', async () => {
  // Regression, found by running this against the estate rather than against a fixture:
  // simt-app's pre-push is git-lfs. pre-push is an event this tool gates *in general*,
  // so keying the chain on the event vocabulary displaced it - and because the repo
  // declares no pre-push gate there is no shim for that event either, so git would
  // find no pre-push hook at all and LFS uploads would stop silently.
  //
  // "Does this tool gate it" is a fact about the manifest, not about the vocabulary.
  const root = await fixture({
    manifest: { gates: { preCommit: ['lint'], prePush: [] }, commands: {} },
    scripts: { lint: 'true' },
    files: { '.git/hooks/pre-push': '#!/bin/sh\nexit 0\n' },
  });
  await chmod(join(root, '.git', 'hooks', 'pre-push'), 0o755);
  const { stderr } = await simt(['hooks', 'install', '--root', root, '--yes'], root);
  assert.match(stderr, /chained pre-push/);
  assert.doesNotMatch(stderr, /stopped running pre-push/);
});

test('hooks install: refuses to install shims for a repo that declares no runnable gate', async () => {
  // A shim with an empty gate list enforces nothing, yet its mere existence
  // replaces whatever git was running. Installing one over a working hook is a
  // downgrade, and `init` already says there is nothing to install.
  const root = await fixture({ manifest: { gates: { preCommit: [], prePush: [] }, commands: {} } });
  await assert.rejects(
    () => simt(['hooks', 'install', '--root', root], root),
    (error) => {
      assert.equal(error.code, 1);
      assert.match(error.stdout, /declares no gate it can run, so there is nothing to enforce/);
      return true;
    },
  );
  await assert.rejects(() => readFile(join(root, HOOKS_DIR, 'pre-commit'), 'utf8'));
});

test('hooks install: a missing shim is not a problem when no gate needs it', async () => {
  const root = await fixture({
    manifest: { gates: { preCommit: ['lint'], prePush: [] }, commands: {} },
    scripts: { lint: 'true' },
  });
  await simt(['hooks', 'install', '--root', root, '--yes'], root);
  const { stdout } = await simt(['hooks', 'status', '--root', root], root);
  assert.doesNotMatch(stdout, /pre-push not installed/);
  assert.equal((stdout.match(/^problems:/m) ?? []).length, 0, stdout);
});

test('hooks install: with no manifest at all, a missing shim is still reported', async () => {
  // Absence of knowledge is not a decision: without a manifest we cannot tell
  // that the repo meant to have no gates.
  const root = await fixture({});
  const { stdout } = await simt(['hooks', 'status', '--root', root], root).catch((e) => e);
  assert.match(stdout, /pre-commit not installed/);
});

test('hooks status: simt-dev shims are not reported as foreign', async () => {
  const root = await fixture({
    manifest: { gates: { preCommit: ['lint'], prePush: [] }, commands: {} },
    scripts: { lint: 'true' },
  });
  await simt(['hooks', 'install', '--root', root, '--yes'], root);
  const { stdout } = await simt(['hooks', 'status', '--root', root], root);
  assert.doesNotMatch(stdout, /not a simt-dev shim/);
});

test('hooks status --json: carries the foreign hooks, not just prose about them', async () => {
  // An agent reading the JSON never sees the text block. A fact that exists only
  // in prose is a fact the tool did not actually report - which is how this very
  // bug hid during development.
  const root = await fixture({
    manifest: { gates: { preCommit: ['lint'], prePush: [] }, commands: {} },
    scripts: { lint: 'true' },
    files: { '.git/hooks/pre-commit': '#!/bin/sh\necho hand-written\n' },
  });
  await chmod(join(root, '.git', 'hooks', 'pre-commit'), 0o755);
  const { stdout } = await simt(['hooks', 'status', '--root', root, '--json'], root).catch((e) => e);
  const payload = JSON.parse(stdout);
  assert.equal(payload.foreign.length, 1);
  assert.equal(payload.foreign[0].event, 'pre-commit');
  assert.equal(payload.foreign[0].bytes, Buffer.byteLength('#!/bin/sh\necho hand-written\n'));
  assert.match(payload.hooksDir, /\.git\/hooks$/);
});

// A dispatcher shim from an earlier version of this tool is ours, out of date - not a
// hook belonging to somebody else. Reading it as foreign made `hooks install --yes`
// print, about a file it had just overwritten:
//
//   stopped running pre-commit at .simt-hooks/pre-commit (2565 bytes); the file is
//   still on disk, untouched - declare it in simt.json gates.commands to have the
//   dispatcher run it
//
// Three false statements in one line: the hook did not stop running, the file was
// touched, and the remedy - declaring the shim as a gate command - makes the dispatcher
// run the dispatcher. Nine estate repositories were routed by a previous release and
// were in exactly this state, so the runbook would have shipped that advice to every
// one of them.
test('a shim this tool wrote in an earlier version is stale, never foreign', async () => {
  const root = await fixture({
    manifest: { gates: { preCommit: ['lint'], prePush: [] }, commands: {} },
    scripts: { lint: 'true' },
  });
  await simt(['hooks', 'install', '--root', root, '--yes'], root);

  // Age it: the banner is how authorship is established, the rest of the bytes is what
  // makes it stale. A 0.1.x shim is exactly this - same banner, older locator.
  const path = join(root, fileFor('pre-commit'));
  const current = await readFile(path, 'utf8');
  const aged = current.replace('#   3. simt on PATH', '#   3. simt-dev on PATH');
  assert.notEqual(aged, current, 'the fixture must actually differ from what this build renders');
  await writeFile(path, aged);
  await chmod(path, 0o755);

  const { stdout, stderr } = await simtAllowingFailure(['hooks', 'status', '--root', root], root);
  const said = stdout + stderr;
  assert.doesNotMatch(said, /not a simt-dev shim/, `our own shim was reported as somebody else's:\n${said}`);
  assert.match(said, /differs from this simt-dev/, 'and the honest reason - it is out of date - must still be there');

  // And install must not tell an operator to declare the shim as a gate command.
  const run = await simt(['hooks', 'install', '--root', root, '--yes'], root);
  const out = run.stdout + run.stderr;
  assert.doesNotMatch(out, /gates\.commands/, `the remedy that runs the dispatcher as a gate must not be offered:\n${out}`);
  assert.doesNotMatch(out, /stopped running/, `a hook that is being refreshed did not stop running:\n${out}`);

  // The genuine case still reads as foreign: a hand-written pre-commit is somebody
  // else's work and must be named as such.
  const hand = await fixture({
    manifest: { gates: { preCommit: ['lint'], prePush: [] }, commands: {} },
    scripts: { lint: 'true' },
  });
  await mkdir(join(hand, HOOKS_DIR), { recursive: true });
  await writeFile(join(hand, fileFor('pre-commit')), '#!/bin/sh\necho mine\n');
  await chmod(join(hand, fileFor('pre-commit')), 0o755);
  await exec('git', ['config', HOOKS_PATH_KEY, HOOKS_DIR], { cwd: hand });
  const ours = await simtAllowingFailure(['hooks', 'status', '--root', hand], hand);
  assert.match(ours.stdout + ours.stderr, /not a simt-dev shim/, 'a hand-written hook must still be reported as foreign');
});

test('a declared gate command is a shell line, so quotes and operators survive', async () => {
  // Before S17 the declaration was split on whitespace, so every one of these ran the
  // wrong thing rather than failing: a flag with a space in its value became two
  // arguments, and the quotes in a compound line were passed to the program as literal
  // characters. There was no way to write a gate with a quoted argument and nothing
  // said so.
  //
  // The proof is an argument with a SPACE in it. Under a whitespace split the script
  // receives "two" as $1 and "words" as $2, writes "two" where it was told, and never
  // runs the second half of the line - so the assertion reads the file back rather than
  // trusting a PASSED that a split could also produce.
  const root = await fixture({
    manifest: {
      gates: {
        preCommit: ['lint'],
        prePush: [],
        commands: { lint: './scripts/gate.sh "two words" second-arg.txt && ./scripts/second.sh' },
      },
    },
    scripts: { lint: 'true' },
    files: {
      'scripts/gate.sh': '#!/bin/sh\nprintf "%s" "$1" > "$2"\n',
      'scripts/second.sh': '#!/bin/sh\ntouch second-ran.txt\n',
    },
    binaries: [],
  });
  await chmod(join(root, 'scripts', 'gate.sh'), 0o755);
  await chmod(join(root, 'scripts', 'second.sh'), 0o755);

  const { stdout, stderr } = await simt(['hooks', 'run', 'pre-commit', '--root', root], root);
  const out = stdout + stderr;
  assert.match(out, /PASSED/, `the gate did not pass:\n${out}`);

  // The argument arrived whole.
  assert.equal(
    await readFile(join(root, 'second-arg.txt'), 'utf8'),
    'two words',
    'the quoted argument was split, so the gate ran a different command than the one declared',
  );
  // And the second half of the line ran, which it cannot do under a split.
  assert.ok(
    existsSync(join(root, 'second-ran.txt')),
    'the && half of the declared command never ran',
  );
});

test('a declared command that genuinely fails still fails the gate', async () => {
  // `sh -c` must not turn a failing declaration into a passing one. The exit status of
  // the shell is the exit status of the command, and a compound line whose second half
  // fails has to be reported as the failure it is.
  const root = await fixture({
    manifest: { gates: { preCommit: ['lint'], prePush: [], commands: { lint: 'false && true' } } },
    scripts: { lint: 'true' },
    binaries: [],
  });
  await simt(['hooks', 'run', 'pre-commit', '--root', root], root).then(
    () => assert.fail('a failing gate must not report success'),
    (error) => {
      const out = `${error.stdout ?? ''}${error.stderr ?? ''}`;
      assert.match(out, /FAILED/, `the gate reported something other than a failure:\n${out}`);
    },
  );
});

// --- install takes away what it installed (S22) ---------------------------------

/**
 * The repository a `hooks install` test runs against: gates, then whatever the test
 * wants on disk, with the routing left wherever install last put it.
 */
async function installedRepo(gates) {
  const root = await fixture({
    scripts: { lint: 'true', test: 'true' },
    manifest: { gates },
    binaries: ['lint', 'test'],
  });
  await simt(['hooks', 'install', '--root', root, '--yes'], root);
  return root;
}

/** A repo-local helper, because `simt` is the binary under test. */
const setManifest = async (root, gates) => {
  await writeFile(join(root, MANIFEST_FILE), JSON.stringify({ id: 'r', stack: [], surfaces: ['cursor'], gates }, null, 2));
};

const hooksPath = (root) =>
  exec('git', ['config', '--get', HOOKS_PATH_KEY], { cwd: root })
    .then((r) => r.stdout.trim())
    .catch(() => null);

test('hooks install: a gate dropped from the manifest has its shim removed, not left running', async () => {
  // `install` only ever ADDED files. Dropping `prePush` from the manifest left its shim
  // on disk: still routed through core.hooksPath, still `PRESENT` in hooks status, and
  // enforcing nothing. That is the exact harm the "nothing to enforce" refusal is written
  // to prevent, reached by the sanctioned path instead of the blocked one - a shim that
  // replaces git's own hook while checking nothing, which is worse than no shim at all.
  const root = await installedRepo({ preCommit: ['lint'], prePush: ['test'] });
  assert.equal((await readdir(join(root, HOOKS_DIR))).length, 2, 'fixture must start with both shims installed');

  await setManifest(root, { preCommit: ['lint'], prePush: [] });
  const run = await simt(['hooks', 'install', '--root', root, '--yes'], root);
  const out = run.stdout + run.stderr;
  // `note` goes to stderr and the plan to stdout; the reader sees both as one report,
  // and an assertion over one stream alone is how a missing note passed review before.
  const stdout = out;


  assert.match(stdout, /REMOVED\s+\.simt-hooks\/pre-push/, stdout);
  // Named in the plan, because a reader about to lose a file is entitled to be told why:
  // "REMOVED pre-push" alone does not distinguish this from a gate dropped by mistake.
  assert.match(stdout, /no gate for pre-push in simt\.json; the shim enforced nothing/, stdout);

  await assert.rejects(() => readFile(join(root, fileFor('pre-push')), 'utf8'), 'the stale shim is still on disk');
  assert.ok(await readFile(join(root, fileFor('pre-commit')), 'utf8'), 'the gate that is still declared must survive');
  // It is still routed, because there is still a shim to route to.
  assert.equal(await hooksPath(root), HOOKS_DIR);

  // And `status` now says what was true all along, rather than `PRESENT ... current`.
  const status = await simt(['hooks', 'status', '--root', root], root);
  assert.match(status.stdout, /ABSENT\s+pre-push\s+not installed/, status.stdout);
});

test('hooks install: removing the last gate takes the shim and the routing with it', async () => {
  // The dead end this was really about. With no gate left there was nothing to install,
  // so install refused and wrote nothing - leaving the shim, the routing, and a remedy
  // ("add the gates this repo can actually run") telling a reader to undo the change they
  // had just made, for a gate possibly gone because the script it ran was deleted. The
  // only way out was to re-declare the gate and delete the file by hand.
  const root = await installedRepo({ preCommit: ['lint'], prePush: ['test'] });

  await setManifest(root, { preCommit: [], prePush: [] });
  const run = await simt(['hooks', 'install', '--root', root, '--yes'], root);
  const out = run.stdout + run.stderr;
  // `note` goes to stderr and the plan to stdout; the reader sees both as one report,
  // and an assertion over one stream alone is how a missing note passed review before.
  const stdout = out;


  assert.match(stdout, /REMOVED\s+\.simt-hooks\/pre-commit/, stdout);
  // The routing goes too. core.hooksPath tells git to read ONE directory for EVERY
  // event, so leaving it pointed at an empty directory stops the repository's own
  // .git/hooks scripts running - silently, which is why the plan has to say so.
  assert.match(stdout, /core\.hooksPath\s+removed/, stdout);
  assert.equal(await hooksPath(root), null, 'core.hooksPath was not unset');
  assert.deepEqual(await readdir(join(root, HOOKS_DIR)), [], 'a shim survived');
});

test('hooks install: a plan that removes the last shim says it un-routes, in prose and in JSON', async () => {
  // A plan printing "core.hooksPath updated .simt-hooks -> .simt-hooks" while the
  // command unsets it is worse than no plan, and the `--json` payload promising a
  // directory the command is about to clear is the same lie in a shape a machine reads.
  const root = await installedRepo({ preCommit: ['lint'], prePush: ['test'] });
  await setManifest(root, { preCommit: [], prePush: [] });

  const dry = await simt(['hooks', 'install', '--root', root], root);
  assert.match(dry.stdout, /core\.hooksPath\s+removed\s+\.simt-hooks -> \(unset\)/, dry.stdout);
  assert.doesNotMatch(dry.stdout, /-> \.simt-hooks\s*$/, dry.stdout);

  const { stdout } = await simt(['hooks', 'install', '--root', root, '--json'], root);
  const payload = JSON.parse(stdout);
  assert.equal(payload.wouldSet, null, payload);
  assert.deepEqual(
    payload.plan.map((p) => `${p.file}:${p.action}`),
    ['.simt-hooks/pre-commit:removed', '.simt-hooks/pre-push:removed'],
  );
  assert.equal(payload.filesWritten, false);
});

test('hooks install: a file a person wrote in the hooks directory is never deleted', async () => {
  // `ours` on each shim is what keeps this true. `state.installed` describes every file
  // in the directory this tool routes to, and only this tool's own were writable by it;
  // a hand-written file there is someone else's, and deleting it is not this command's
  // to do. Reading `stale` instead would have deleted it, because a hand-written file
  // never matches what this tool renders and so reads as stale.
  const root = await installedRepo({ preCommit: ['lint'], prePush: ['test'] });
  const mine = join(root, HOOKS_DIR, 'mine');
  await writeFile(mine, '#!/bin/sh\necho hi\n');
  await chmod(mine, 0o755);

  await setManifest(root, { preCommit: [], prePush: [] });
  const run = await simt(['hooks', 'install', '--root', root, '--yes'], root);
  const out = run.stdout + run.stderr;
  // `note` goes to stderr and the plan to stdout; the reader sees both as one report,
  // and an assertion over one stream alone is how a missing note passed review before.
  const stdout = out;

  assert.ok(await readFile(mine, 'utf8'), 'a file this tool did not write was deleted');
  assert.deepEqual(await readdir(join(root, HOOKS_DIR)), ['mine'], 'only the shims should be gone');
  // Nor is it adopted: it appears nowhere in the plan, only in the note explaining why
  // chaining it was impossible. `install` neither wrote it nor took it away, because a
  // file this tool did not author is not this command's to change.
  const planOnly = stdout.split('WROTE')[0];
  assert.doesNotMatch(planOnly, /mine/, stdout);
});

test('hooks install: a chained shim survives an install that removes a dispatcher shim', async () => {
  // `obsolete` excludes `chained`, because a chained shim is a file this install
  // maintains - it re-renders it from the file's own contents on every run. Without the
  // exclusion, removing a gate would have taken the repository's own hook with it.
  const root = await fixture({
    scripts: { lint: 'true', test: 'true' },
    manifest: { gates: { preCommit: ['lint'], prePush: [] } },
    binaries: ['lint', 'test'],
  });
  const own = join(root, '.git', 'hooks', 'post-commit');
  await mkdir(dirname(own), { recursive: true });
  await writeFile(own, '#!/bin/sh\nexit 0\n');
  await chmod(own, 0o755);

  await simt(['hooks', 'install', '--root', root, '--yes'], root);
  assert.ok(
    (await readdir(join(root, HOOKS_DIR))).includes('post-commit'),
    'fixture must start with the repository hook chained',
  );

  // Every gate gone, so this run has nothing to write and takes away the dispatcher shim.
  await setManifest(root, { preCommit: [], prePush: [] });
  const run = await simt(['hooks', 'install', '--root', root, '--yes'], root);
  const out = run.stdout + run.stderr;
  // `note` goes to stderr and the plan to stdout; the reader sees both as one report,
  // and an assertion over one stream alone is how a missing note passed review before.
  const stdout = out;


  assert.match(stdout, /REMOVED\s+\.simt-hooks\/pre-commit/, stdout);
  assert.ok(
    (await readdir(join(root, HOOKS_DIR))).includes('post-commit'),
    'the chained shim was deleted along with the dispatcher shim',
  );
  // The directory is still routed, because the chained shim is still there to run.
  assert.equal(await hooksPath(root), HOOKS_DIR);
});

test('hooks install: a hook in this tool\'s own directory is not chained to itself', async () => {
  // `foreignHooks` lists every executable file in the directory git reads hooks from, and
  // when core.hooksPath is this tool's own, a file a person dropped in there is listed
  // too. Chaining it wrote `.simt-hooks/<name>` with TARGET `.simt-hooks/<name>` - the
  // same path - so the shim overwrote the hook it was written to preserve and then ran
  // itself. The previous release printed `UPDATED .simt-hooks/mine (chained: runs
  // .simt-hooks/mine)` and exited 0.
  const root = await fixture({
    scripts: { lint: 'true', test: 'true' },
    manifest: { gates: { preCommit: ['lint'], prePush: ['test'] } },
    binaries: ['lint', 'test'],
  });
  await simt(['hooks', 'install', '--root', root, '--yes'], root);

  const mine = join(root, HOOKS_DIR, 'mine');
  const original = '#!/bin/sh\necho hi\n';
  await writeFile(mine, original);
  await chmod(mine, 0o755);

  const run = await simt(['hooks', 'install', '--root', root, '--yes'], root);
  const out = run.stdout + run.stderr;
  // `note` goes to stderr and the plan to stdout; the reader sees both as one report,
  // and an assertion over one stream alone is how a missing note passed review before.
  const stdout = out;

  // Left untouched, byte for byte. This is the assertion the self-chaining failed: it
  // overwrote the file with a shim that ran itself.
  assert.equal(await readFile(mine, 'utf8'), original, 'the hand-written file was overwritten');
  assert.doesNotMatch(stdout, /chained mine/, stdout);
  assert.doesNotMatch(stdout, new RegExp(`UPDATED\\s+${HOOKS_DIR}/mine`), stdout);

  // And it is reported as what it is, which is neither "chained" nor "stopped running".
  // Both other wordings were used about this file and both were false.
  assert.match(stdout, /mine .* is in this tool's own hooks directory, so it cannot be chained to itself and was left untouched; it keeps running/, stdout);

  // It is also not adopted: git still runs the file itself, so it must not be renamed
  // into the shim namespace or moved anywhere the reader would not find it.
  assert.ok(existsSync(mine), 'the file moved');
  assert.match(stdout, /REMOVED\s+\.simt-hooks\/pre-commit|UNCHANGED\s+\.simt-hooks\/pre-commit/, stdout);
});

test('hooks install: a hand-written file NAMED for a gated event is not deleted either', async () => {
  // The case the authorship check exists for, which the other test cannot reach.
  // `state.installed` iterates the two events this tool gates, so a file at
  // `.simt-hooks/mine` is not in that list at all and the filter never sees it. The
  // guard is for a file at `.simt-hooks/pre-commit` that a person wrote by hand -
  // which happens, because that is exactly where a reader of the install plan would
  // look, and because a repository that abandoned this tool has its own hooks there.
  //
  // Reading `stale` instead of `ours` would delete it: a hand-written file never
  // matches what this tool renders, so it reads as stale, and every shim an install
  // is about to overwrite reads that way too.
  const root = await installedRepo({ preCommit: ['lint'], prePush: ['test'] });
  const theirOwn = '#!/bin/sh\n# my own pre-commit\nexit 0\n';
  await writeFile(join(root, fileFor('pre-commit')), theirOwn);

  await setManifest(root, { preCommit: [], prePush: [] });
  const run = await simt(['hooks', 'install', '--root', root, '--yes'], root);
  const out = run.stdout + run.stderr;
  const stdout = out;

  // Untouched, and reported as neither written nor removed.
  assert.equal(await readFile(join(root, fileFor('pre-commit')), 'utf8'), theirOwn, 'a hand-written file was deleted');
  const planOnly = stdout.split('WROTE')[0];
  assert.doesNotMatch(planOnly, /\.simt-hooks\/pre-commit/, `plan touched a file this tool did not write:\n${stdout}`);
  // The one it DID write is still removed, so this is not a blanket refusal.
  await assert.rejects(() => readFile(join(root, fileFor('pre-push')), 'utf8'), 'the shim for the dropped gate survived');
});
