import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readdir, readFile, realpath, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';

import { PACKAGE_NAME } from '../src/name.mjs';
import { after, test } from 'node:test';

import { GATE_KINDS, GATES, FORMATTABLE, gateNames } from '../src/hooks/gates.mjs';
import { EVENTS, HOOKS_DIR, HOOKS_DIR_LEGACY, HOOKS_PATH_KEY, SHIM_MARKER, fileFor, renderChainedShim, renderShim } from '../src/hooks/shim.mjs';
import { hasScript, resolveGate, resolveStagedTool } from '../src/hooks/resolve.mjs';
import { classifyPush, parsePushedRefs, renderGateReport, runGates, stagedFiles } from '../src/hooks/dispatcher.mjs';
import { recordRun } from '../src/ledger/index.mjs';
import { packageVersion } from '../src/package-version.mjs';
import { readCapability } from '../src/hooks/capability.mjs';
import * as gateModule from '../src/projection/manifest.mjs';
import { git, cmd } from './fixture.mjs';
import { CLI } from '../src/name.mjs';
import { MANIFEST_FILE } from '../src/name.mjs';
import { simt as simtCli } from './fixture.mjs';

/**
 * One run of the real binary, both paths. `check` is the only surface that can say a
 * `gates.cwd` is wrong before a commit, so the test that claims `check` does has to run
 * `check` - through the binary, as a reader would.
 */
const run = (args) => simtCli(args, { maxBuffer: 16 << 20 }).then(({ code, stdout, stderr }) => ({ code, out: stdout + stderr }));

const exec = promisify(execFile);
const BIN = new URL('../bin/simt.mjs', import.meta.url).pathname;
const temps = [];

after(async () => {
  for (const t of temps) await exec('rm', ['-rf', t]);
});

async function fixture({ scripts, manifest, files = {}, binaries = [], formatter = false } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'simt-hooksd-'));
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
  return exec(process.execPath, [BIN, ...args], { cwd, env: { ...process.env, NO_COLOR: '1' } });
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

const SKIP_TEST = { maxCommits: 2, paths: ['**/*.md', 'docs/**'] };

/**
 * A fixture repo with a base commit and one commit on top, plus the stdin line
 * git feeds a pre-push that pushes the top commit to an existing branch: the
 * remote sha is the base, so the diff is exactly the top commit.
 */
async function twoCommitPush({ files = {}, topFiles = {}, manifest }) {
  const root = await fixture({ scripts: { test: 'exit 0' }, files, manifest });
  await git(['add', '-A'], { cwd: root });
  await git(['commit', '-m', 'base'], { cwd: root });
  const { stdout: base } = await exec('git', ['rev-parse', 'HEAD'], { cwd: root });
  for (const [name, body] of Object.entries(topFiles)) {
    await mkdir(join(root, dirname(name)), { recursive: true });
    await writeFile(join(root, name), body);
  }
  await git(['add', '-A'], { cwd: root });
  await git(['commit', '-m', 'top'], { cwd: root });
  const { stdout: head } = await exec('git', ['rev-parse', 'HEAD'], { cwd: root });
  return { root, base: base.trim(), head: head.trim(), pushed: `refs/heads/main ${head.trim()} refs/heads/main ${base.trim()}\n` };
}

async function recordGreenSuite(root) {
  await recordRun(root, { cmd: 'npm test', exit: 0, ms: 120, output: '1580 pass, 0 fail', gate: 'test', kind: 'test' });
}

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

test('shim: a .mjs entry point without node on PATH says what to install', async () => {
  // Regression: a GUI client's PATH often carries no node (nvm is sourced only in an
  // interactive shell), and `exec node` there failed with 127 and no remedy. The
  // shim is run here with a PATH that holds git and nothing else.
  const root = await mkdtemp(join(tmpdir(), 'simt-shim-'));
  temps.push(root);
  await exec('git', ['init', '-q', '-b', 'main'], { cwd: root });
  const only = await mkdtemp(join(tmpdir(), 'simt-path-'));
  temps.push(only);
  const git = (await exec('sh', ['-c', 'command -v git'])).stdout.trim();
  await exec('ln', ['-s', git, join(only, 'git')]);

  const path = join(root, fileFor('pre-commit'));
  await mkdir(join(path, '..'), { recursive: true });
  await writeFile(path, renderShim('pre-commit'));
  await chmod(path, 0o755);

  // The shell is named by absolute path: `sh` itself is resolved through the PATH the
  // child is given, so a PATH with only git would fail to start the script at all.
  const result = await exec('/bin/sh', [path], {
    cwd: root,
    env: { ...process.env, SIMT_DEV_BIN: BIN, PATH: only },
  }).catch((error) => ({ stderr: error.stderr, code: error.code }));

  assert.match(result.stderr, /cannot find node/);
  assert.match(result.stderr, /install Node >= 22\.20\.0/);
  assert.equal(result.code, 1);
});

test('shim: SIMT_DEV_BIN naming a path with a space is run, not refused', async () => {
  // A checkout under "~/My Projects" is a path, and the old refusal read its space as
  // a command line. A value that names a file is one program.
  const root = await mkdtemp(join(tmpdir(), 'simt-shim-'));
  temps.push(root);
  await exec('git', ['init', '-q', '-b', 'main'], { cwd: root });
  await writeFile(join(root, MANIFEST_FILE), JSON.stringify({ gates: { preCommit: [], prePush: [] } }));
  const spaced = join(root, 'with space');
  await mkdir(spaced, { recursive: true });
  const entry = join(spaced, 'simt.mjs');
  await exec('ln', ['-s', BIN, entry]);

  const path = join(root, fileFor('pre-commit'));
  await mkdir(join(path, '..'), { recursive: true });
  await writeFile(path, renderShim('pre-commit'));
  await chmod(path, 0o755);

  const { stdout } = await exec('sh', [path], {
    cwd: root,
    env: { ...process.env, SIMT_DEV_BIN: entry, PATH: process.env.PATH },
  });
  assert.match(stdout, /^hooks\s+pre-commit/m);
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
    // Read from GATE_KINDS, the declared set: a hand-kept list here would be a
    // second copy of the same fact, which is how a new kind ships unannounced.
    assert.ok(GATE_KINDS.has(gate.kind), `${gate.name} kind`);
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
  const names = gateNames();
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

test('agenthook: prompt-submit reads the repository --root names, not the payload cwd', async () => {
  // Regression: the delivery resolved its root from the payload alone, so a packaged
  // hook - running in the plugin directory - found no manifest and delivered nothing,
  // which reads exactly like a repository that opted out.
  const root = await fixture({ manifest: { brief: {} } });
  const elsewhere = await mkdtemp(join(tmpdir(), 'simt-cwd-'));
  temps.push(elsewhere);
  const payload = join(root, 'payload.json');
  await writeFile(payload, JSON.stringify({ prompt: 'add a hook', cwd: elsewhere }));
  const { stdout, stderr } = await exec(
    '/bin/sh',
    ['-c', `"${process.execPath}" "${BIN}" agent-hook prompt-submit --harness claude --root "${root}" < "${payload}"`],
    { cwd: elsewhere },
  );
  // A delivery that delivers nothing says why on stderr and still exits 0.
  const out = stdout + stderr;
  assert.doesNotMatch(out, /no manifest/);
  assert.match(out, /the index is empty/);
});

test('dispatcher: gates.timeout bounds a hung gate and says which bound it hit', async () => {
  // The defect: a gate waiting on something that never closes blocked the commit with
  // no output and no way to tell a hang from slow work.
  const manifest = { gates: { preCommit: ['test'], prePush: [], timeout: { test: 1 }, commands: { test: 'sleep 30' } } };
  const root = await fixture({ manifest });
  const started = Date.now();
  const result = await runGates('pre-commit', { root, manifest });
  const gate = result.gates.find((g) => g.name === 'test');
  assert.equal(gate.status, 'failed');
  assert.match(gate.detail, /timed out after 1 s/);
  assert.match(gate.remedy, /gates\.timeout/);
  assert.equal(result.failed, true);
  assert.ok(Date.now() - started < 20_000, 'the bound did not end the run');
});

test('dispatcher: a passing gate that prints beyond the output cap still passes', async () => {
  // The defect: execFile rejected the whole run once its buffer filled, so a gate that
  // printed a lot and exited 0 was reported failed. The cap belongs on what is kept.
  const root = await fixture({
    files: { 'noisy.mjs': "process.stdout.write('x'.repeat(9 * 1024 * 1024));" },
    manifest: { gates: { preCommit: ['test'], prePush: [], commands: { test: 'node noisy.mjs' } } },
  });
  const manifest = { gates: { preCommit: ['test'], prePush: [], commands: { test: 'node noisy.mjs' } } };
  const result = await runGates('pre-commit', { root, manifest });
  const gate = result.gates.find((g) => g.name === 'test');
  assert.equal(gate.status, 'passed');
  assert.equal(result.failed, false);
});

test('dispatcher: a staged path containing a newline is read as one path', async () => {
  // `--name-only` without `-z` quotes such a name, and a quoted name is not the path in
  // the index: every later membership test compared quotation against reality.
  const root = await fixture({});
  const name = 'weird\nname.txt';
  await writeFile(join(root, name), 'x');
  await exec('git', ['add', '--', name], { cwd: root });
  assert.deepEqual(await stagedFiles(root), [name]);
});

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

test('dispatcher: gates.cwd runs the gate in the directory it names', async () => {
  // The monorepo case: the root has no `test` script, the package does, and the gate
  // must run where the script is. Asserted on the working directory the command sees,
  // because "the gate passed" is equally true of a run in the wrong place.
  const manifest = {
    gates: {
      preCommit: ['test'],
      prePush: [],
      commands: { test: 'pwd > where.txt' },
      cwd: { test: 'apps/web' },
    },
  };
  const root = await fixture({ scripts: {}, manifest, files: { 'apps/web/.keep': '' } });
  const result = await runGates('pre-commit', { root, manifest });
  assert.equal(result.failed, false, JSON.stringify(result.gates));
  // `pwd` reports the resolved path, and macOS answers `/private/var` for a
  // `/var` temp dir. Comparing the two through `realpath` asserts the directory and
  // not the spelling of the path that reached it.
  assert.equal(
    (await readFile(join(root, 'apps', 'web', 'where.txt'), 'utf8')).trim(),
    await realpath(join(root, 'apps', 'web')),
  );
});

test('dispatcher: a gates.cwd that does not resolve blocks the event, and says which of two things is wrong', async () => {
  const base = { gates: { preCommit: ['test'], prePush: [], commands: { test: 'node -e ""' } } };
  for (const [dir, pattern] of [
    ['apps/nope', /not a directory in this repository/],
    ['../elsewhere', /outside the repository/],
  ]) {
    const manifest = { gates: { ...base.gates, cwd: { test: dir } } };
    const root = await fixture({ manifest, files: { 'apps/web/.keep': '' } });
    const result = await runGates('pre-commit', { root, manifest });
    assert.equal(result.failed, true, `${dir} must not pass silently`);
    assert.match(result.gates[0].detail, pattern);
    assert.ok(result.gates[0].remedy, 'a refusal without a repair is a dead end');
  }
});

test('check: a gates.cwd that does not resolve is a finding, and a name no gate declares is too', async () => {
  const gates = { preCommit: ['test'], prePush: [], commands: { test: 'node -e ""' } };
  const root = await fixture({ manifest: { gates: { ...gates, cwd: { test: 'apps/nope', lint: 'apps/web' } } } });
  const out = await run(['check', '--root', root]);
  assert.equal(out.code, 1, out.out);
  assert.match(out.out, /GATE-CWD-MISSING/);
  // A `cwd` for a gate that does not exist is inert, and the reader believes otherwise.
  assert.match(out.out, /UNKNOWN-GATE-CWD/);
  const gateModule = await import('../src/projection/manifest.mjs');
  const findings = gateModule.unrunnableGates(
    { gates: { ...gates, cwd: { lint: 'apps/web' } } },
    { scripts: {}, binaries: [], commands: {}, tools: [] },
  );
  assert.deepEqual(findings.filter((f) => f.status === 'unknown-gate-cwd').map((f) => f.gate), ['lint']);
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
  await git(['add', '-A'], { cwd: root });
  await git(['commit', '-m', 'init'], { cwd: root });
  const result = await runGates('pre-push', { root, manifest });
  assert.deepEqual(result.gates.map((g) => g.name), ['test']);
});

test('dispatcher: pre-push runs on HEAD, so uncommitted WIP does not block the push', async () => {
  // The gate's test script fails when data.txt says "bad". The committed tree says
  // "good"; the working tree has been edited to "bad". A pre-push gate that ran on the
  // working tree would fail and block the push of a commit that is itself fine - which
  // is exactly what the worktree-at-HEAD run exists to prevent.
  const manifest = { gates: { preCommit: [], prePush: ['test'] } };
  const root = await fixture({ scripts: { test: 'grep -q good data.txt' }, files: { 'data.txt': 'good\n' }, manifest });
  await git(['add', '-A'], { cwd: root });
  await git(['commit', '-m', 'init'], { cwd: root });
  // WIP: the working tree now fails the gate, but HEAD does not.
  await writeFile(join(root, 'data.txt'), 'bad\n');
  const result = await runGates('pre-push', { root, manifest });
  assert.equal(result.failed, false, `expected pre-push to pass on HEAD, got: ${JSON.stringify(result.gates)}`);
  assert.equal(result.gates.find((g) => g.name === 'test').status, 'passed');
});

test('dispatcher: pre-push fails closed when HEAD cannot be materialized (no commits)', async () => {
  // An unborn HEAD has no committed tree to run against. The gate cannot invent one,
  // so it fails with a reason rather than running against a tree it cannot name.
  const manifest = { gates: { preCommit: [], prePush: ['test'] } };
  const root = await fixture({ scripts: { test: 'exit 0' }, manifest });
  const result = await runGates('pre-push', { root, manifest });
  assert.equal(result.failed, true);
  const gate = result.gates.find((g) => g.name === 'head');
  assert.equal(gate.status, 'failed');
  assert.match(gate.detail, /git worktree add failed/);
});

// ------------------------------------------------ pre-push docs-only skip (ADR-113)

/** The classifier's ceiling and paths, as a manifest would declare them. */
test('dispatcher: a docs-only push skips the test gate and reports why', async () => {
  const manifest = { gates: { preCommit: [], prePush: ['test'], prePushSkipTest: SKIP_TEST } };
  const { root, pushed } = await twoCommitPush({ files: { 'base.md': 'a\n' }, topFiles: { 'notes.md': 'b\n' }, manifest });
  const result = await runGates('pre-push', { root, manifest, pushed });
  assert.equal(result.failed, false);
  const gate = result.gates.find((g) => g.name === 'test');
  assert.equal(gate.status, 'skipped');
  assert.match(gate.detail, /docs-only push: 1 commit\(s\) touching 1 file\(s\), all inside the docs-only paths/);
  // The report names the skip: a gate that did not run must be visible as such.
  assert.match(renderGateReport('pre-push', ['test'], result).join('\n'), /SKIPPED\s+test/);
});

test('dispatcher: a push that touches code runs the test gate', async () => {
  const manifest = { gates: { preCommit: [], prePush: ['test'], prePushSkipTest: SKIP_TEST } };
  const { root, pushed } = await twoCommitPush({ files: { 'base.md': 'a\n' }, topFiles: { 'src/x.js': '1\n' }, manifest });
  const result = await runGates('pre-push', { root, manifest, pushed });
  assert.equal(result.gates.find((g) => g.name === 'test').status, 'passed');
});

test('dispatcher: more commits than the ceiling runs the test gate', async () => {
  const manifest = { gates: { preCommit: [], prePush: ['test'], prePushSkipTest: SKIP_TEST } };
  const root = await fixture({ scripts: { test: 'exit 0' }, files: { 'a.md': '1\n' }, manifest });
  await git(['add', '-A'], { cwd: root });
  await git(['commit', '-m', 'base'], { cwd: root });
  const { stdout: base } = await exec('git', ['rev-parse', 'HEAD'], { cwd: root });
  for (const name of ['b.md', 'c.md', 'd.md']) {
    await writeFile(join(root, name), `${name}\n`);
    await git(['add', '-A'], { cwd: root });
    await git(['commit', '-m', name], { cwd: root });
  }
  const { stdout: head } = await exec('git', ['rev-parse', 'HEAD'], { cwd: root });
  const pushed = `refs/heads/main ${head.trim()} refs/heads/main ${base.trim()}\n`;
  const result = await runGates('pre-push', { root, manifest, pushed });
  assert.equal(result.gates.find((g) => g.name === 'test').status, 'passed');
});

test('dispatcher: a new branch cannot be diffed against the remote, so the test gate runs', async () => {
  const manifest = { gates: { preCommit: [], prePush: ['test'], prePushSkipTest: SKIP_TEST } };
  const { root, head } = await twoCommitPush({ files: { 'base.md': 'a\n' }, topFiles: { 'notes.md': 'b\n' }, manifest });
  const pushed = `refs/heads/fresh ${head} refs/heads/fresh ${'0'.repeat(40)}\n`;
  const result = await runGates('pre-push', { root, manifest, pushed });
  assert.equal(result.gates.find((g) => g.name === 'test').status, 'passed');
});

test('dispatcher: a branch deletion pushes no commits and earns the skip', async () => {
  const manifest = { gates: { preCommit: [], prePush: ['test'], prePushSkipTest: SKIP_TEST } };
  const { root, base } = await twoCommitPush({ files: { 'base.md': 'a\n' }, topFiles: { 'notes.md': 'b\n' }, manifest });
  const pushed = `refs/heads/main ${'0'.repeat(40)} refs/heads/main ${base}\n`;
  const result = await runGates('pre-push', { root, manifest, pushed });
  assert.equal(result.failed, false);
  const gate = result.gates.find((g) => g.name === 'test');
  assert.equal(gate.status, 'skipped');
  assert.match(gate.detail, /deletion push: 1 ref deletion\(s\)/);
});

test('dispatcher: without prePushSkipTest the suite runs on every push', async () => {
  const manifest = { gates: { preCommit: [], prePush: ['test'] } };
  const { root, pushed } = await twoCommitPush({ files: { 'base.md': 'a\n' }, topFiles: { 'notes.md': 'b\n' }, manifest });
  const result = await runGates('pre-push', { root, manifest, pushed });
  assert.equal(result.gates.find((g) => g.name === 'test').status, 'passed');
});

test('dispatcher: a manual run with no stdin runs the suite', async () => {
  const manifest = { gates: { preCommit: [], prePush: ['test'], prePushSkipTest: SKIP_TEST } };
  const { root } = await twoCommitPush({ files: { 'base.md': 'a\n' }, topFiles: { 'notes.md': 'b\n' }, manifest });
  const result = await runGates('pre-push', { root, manifest });
  assert.equal(result.gates.find((g) => g.name === 'test').status, 'passed');
});

test('dispatcher: an unreadable ref list fails closed to the suite', async () => {
  const manifest = { gates: { preCommit: [], prePush: ['test'], prePushSkipTest: SKIP_TEST } };
  const { root } = await twoCommitPush({ files: { 'base.md': 'a\n' }, topFiles: { 'notes.md': 'b\n' }, manifest });
  const result = await runGates('pre-push', { root, manifest, pushed: 'not a ref list\n' });
  assert.equal(result.gates.find((g) => g.name === 'test').status, 'passed');
});

test('dispatcher: a misdeclared prePushSkipTest fails closed to the suite', async () => {
  const manifest = { gates: { preCommit: [], prePush: ['test'], prePushSkipTest: { paths: ['**/*.md'] } } };
  const { root, pushed } = await twoCommitPush({ files: { 'base.md': 'a\n' }, topFiles: { 'notes.md': 'b\n' }, manifest });
  const result = await runGates('pre-push', { root, manifest, pushed });
  assert.equal(result.gates.find((g) => g.name === 'test').status, 'passed');
});

test('parsePushedRefs: reads git pre-push lines and refuses what it cannot read', () => {
  const local = 'a'.repeat(40);
  const remote = 'f'.repeat(40);
  const ok = parsePushedRefs(`refs/heads/main ${local} refs/heads/main ${remote}\n\n`);
  assert.equal(ok.error, null);
  assert.deepEqual(ok.refs, [{ ref: 'refs/heads/main', localSha: local, remoteSha: remote }]);
  assert.deepEqual(parsePushedRefs('').refs, []);
  assert.match(parsePushedRefs('garbage').error, /unrecognized pre-push line/);
  assert.match(parsePushedRefs(`refs/heads/main notash refs/heads/main ${remote}\n`).error, /unrecognized sha/);
});

test('classifyPush: a file outside the declared paths fails closed', async () => {
  const { root, base, head } = await twoCommitPush({ files: { 'base.md': 'a\n' }, topFiles: { 'src/x.js': '1\n' }, manifest: {} });
  const verdict = await classifyPush(root, [{ ref: 'refs/heads/main', localSha: head, remoteSha: base }], SKIP_TEST);
  assert.equal(verdict.docsOnly, false);
  assert.match(verdict.reason, /outside the docs-only paths: src\/x\.js/);
});

test('classifyPush: a diff git cannot answer fails closed', async () => {
  const { root } = await twoCommitPush({ files: { 'base.md': 'a\n' }, topFiles: { 'notes.md': 'b\n' }, manifest: {} });
  const missing = 'c'.repeat(40);
  const verdict = await classifyPush(root, [{ ref: 'refs/heads/main', localSha: missing, remoteSha: missing }], SKIP_TEST);
  assert.equal(verdict.docsOnly, false);
  assert.match(verdict.reason, /could not be diffed/);
});

test('classifyPush: an empty ref list fails closed', async () => {
  const { root } = await twoCommitPush({ files: { 'base.md': 'a\n' }, topFiles: { 'notes.md': 'b\n' }, manifest: {} });
  const verdict = await classifyPush(root, [], SKIP_TEST);
  assert.equal(verdict.docsOnly, false);
  assert.match(verdict.reason, /no readable ref list/);
});

test('dispatcher: a tag on an already-pushed commit skips the test gate', async () => {
  const manifest = { gates: { preCommit: [], prePush: ['test'], prePushSkipTest: SKIP_TEST } };
  const { root, head } = await twoCommitPush({ files: { 'base.md': 'a\n' }, topFiles: { 'notes.md': 'b\n' }, manifest });
  // The branch was pushed first, so the remote already has `head`; the tag names it.
  await git(['update-ref', 'refs/remotes/origin/main', head], { cwd: root });
  await git(['tag', 'v1.0', head], { cwd: root });
  const tagSha = (await exec('git', ['rev-parse', 'v1.0'], { cwd: root })).stdout.trim();
  const pushed = `refs/tags/v1.0 ${tagSha} refs/tags/v1.0 ${'0'.repeat(40)}\n`;
  const result = await runGates('pre-push', { root, manifest, pushed });
  assert.equal(result.failed, false);
  const gate = result.gates.find((g) => g.name === 'test');
  assert.equal(gate.status, 'skipped');
  // A push that carries only a tag is a tag push; the report must not call it docs-only.
  assert.match(gate.detail, /tag push: 1 tag\(s\) already delivered/);
  assert.doesNotMatch(gate.detail, /docs-only/);
});
