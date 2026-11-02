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

test('dispatcher: a tag whose commit no pushed ref contains runs the test gate', async () => {
  const manifest = { gates: { preCommit: [], prePush: ['test'], prePushSkipTest: SKIP_TEST } };
  const { root, head } = await twoCommitPush({ files: { 'base.md': 'a\n' }, topFiles: { 'notes.md': 'b\n' }, manifest });
  // No remote-tracking ref is known, so the tag's commit cannot be confirmed as
  // already delivered; the gate does not assume a tag is harmless.
  await git(['tag', 'v1.0', head], { cwd: root });
  const tagSha = (await exec('git', ['rev-parse', 'v1.0'], { cwd: root })).stdout.trim();
  const pushed = `refs/tags/v1.0 ${tagSha} refs/tags/v1.0 ${'0'.repeat(40)}\n`;
  const result = await runGates('pre-push', { root, manifest, pushed });
  assert.equal(result.gates.find((g) => g.name === 'test').status, 'passed');
});

test('dispatcher: a tag riding a docs-only branch push skips the test gate', async () => {
  const manifest = { gates: { preCommit: [], prePush: ['test'], prePushSkipTest: SKIP_TEST } };
  const { root, base, head } = await twoCommitPush({ files: { 'base.md': 'a\n' }, topFiles: { 'notes.md': 'b\n' }, manifest });
  // The tag names the commit the branch is delivering in this same push.
  await git(['tag', 'v1.0', head], { cwd: root });
  const tagSha = (await exec('git', ['rev-parse', 'v1.0'], { cwd: root })).stdout.trim();
  const pushed = `refs/heads/main ${head} refs/heads/main ${base}\nrefs/tags/v1.0 ${tagSha} refs/tags/v1.0 ${'0'.repeat(40)}\n`;
  const result = await runGates('pre-push', { root, manifest, pushed });
  assert.equal(result.failed, false);
  const gate = result.gates.find((g) => g.name === 'test');
  assert.equal(gate.status, 'skipped');
  // Commits are being delivered, so the push kind stays docs-only even with a tag aboard.
  assert.match(gate.detail, /^docs-only push: 1 commit\(s\) touching 1 file\(s\)/);
  assert.match(gate.detail, /1 tag\(s\) already delivered/);
});

test('dispatcher: an annotated tag is dereferenced to its commit before classification', async () => {
  const manifest = { gates: { preCommit: [], prePush: ['test'], prePushSkipTest: SKIP_TEST } };
  const { root, head } = await twoCommitPush({ files: { 'base.md': 'a\n' }, topFiles: { 'notes.md': 'b\n' }, manifest });
  await git(['update-ref', 'refs/remotes/origin/main', head], { cwd: root });
  // An annotated tag's pre-push sha is the tag OBJECT, not the commit; the
  // classifier must resolve it to the commit it seals.
  await git(['tag', '-a', 'v1.0', '-m', 'release', head], { cwd: root });
  const tagSha = (await exec('git', ['rev-parse', 'v1.0'], { cwd: root })).stdout.trim();
  assert.notEqual(tagSha, head, 'the tag object sha differs from the commit sha');
  const pushed = `refs/tags/v1.0 ${tagSha} refs/tags/v1.0 ${'0'.repeat(40)}\n`;
  const result = await runGates('pre-push', { root, manifest, pushed });
  assert.equal(result.gates.find((g) => g.name === 'test').status, 'skipped');
});

// ------------------------------------------------ pre-push already-passing skip (ADR-120)

/**
 * A passing `test` run recorded against `root`'s current clean tree, the way the dispatcher
 * records one when the author runs the suite. The tree it names is the committed tree, so
 * the pre-push gate can match it against `HEAD^{tree}`.
 */
test('dispatcher: a push of an already-green tree skips the test gate on its evidence', async () => {
  const manifest = { gates: { preCommit: [], prePush: ['test'] } };
  const root = await fixture({ scripts: { test: 'exit 0' }, files: { 'a.md': '1\n' }, manifest });
  await git(['add', '-A'], { cwd: root });
  await git(['commit', '-m', 'base'], { cwd: root });
  await recordGreenSuite(root);
  const result = await runGates('pre-push', { root, manifest });
  assert.equal(result.failed, false);
  const gate = result.gates.find((g) => g.name === 'test');
  assert.equal(gate.status, 'skipped');
  assert.match(gate.detail, /already passing on current state/);
  // The report names the record that earned the skip, so a skip is never silent.
  assert.match(renderGateReport('pre-push', ['test'], result).join('\n'), /SKIPPED\s+test.*\[ADR-120\]/);
});

test('dispatcher: a push with no recorded run runs the test gate', async () => {
  const manifest = { gates: { preCommit: [], prePush: ['test'] } };
  const root = await fixture({ scripts: { test: 'exit 0' }, files: { 'a.md': '1\n' }, manifest });
  await git(['add', '-A'], { cwd: root });
  await git(['commit', '-m', 'base'], { cwd: root });
  const result = await runGates('pre-push', { root, manifest });
  assert.equal(result.gates.find((g) => g.name === 'test').status, 'passed');
});

test('dispatcher: a later failure cancels the pass, so the suite runs', async () => {
  const manifest = { gates: { preCommit: [], prePush: ['test'] } };
  const root = await fixture({ scripts: { test: 'exit 0' }, files: { 'a.md': '1\n' }, manifest });
  await git(['add', '-A'], { cwd: root });
  await git(['commit', '-m', 'base'], { cwd: root });
  // Green, then red on the same tree: a pass followed by a failure proves nothing.
  await recordRun(root, { cmd: 'npm test', exit: 0, ms: 120, output: '1580 pass, 0 fail', gate: 'test', kind: 'test' });
  await recordRun(root, { cmd: 'npm test', exit: 1, ms: 120, output: '1579 pass, 1 fail', gate: 'test', kind: 'test' });
  const result = await runGates('pre-push', { root, manifest });
  assert.equal(result.gates.find((g) => g.name === 'test').status, 'passed');
});

test('dispatcher: a code push that is not docs-only skips on evidence when present', async () => {
  // With prePushSkipTest declared, a code push is not docs-only, so the docs-only path yields
  // and the evidence path decides: green evidence skips, none runs the suite.
  const manifest = { gates: { preCommit: [], prePush: ['test'], prePushSkipTest: SKIP_TEST } };
  const root = await fixture({ scripts: { test: 'exit 0' }, files: { 'src/x.js': '1\n' }, manifest });
  await git(['add', '-A'], { cwd: root });
  await git(['commit', '-m', 'base'], { cwd: root });
  const { stdout: base } = await exec('git', ['rev-parse', 'HEAD'], { cwd: root });
  await writeFile(join(root, 'src/y.js'), '2\n');
  await git(['add', '-A'], { cwd: root });
  await git(['commit', '-m', 'top'], { cwd: root });
  const { stdout: head } = await exec('git', ['rev-parse', 'HEAD'], { cwd: root });
  // The evidence is for the top tree the push delivers; the push line carries the code.
  await recordGreenSuite(root);
  const pushed = `refs/heads/main ${head.trim()} refs/heads/main ${base.trim()}\n`;
  const result = await runGates('pre-push', { root, manifest, pushed });
  assert.equal(result.failed, false);
  const gate = result.gates.find((g) => g.name === 'test');
  assert.equal(gate.status, 'skipped');
  assert.match(gate.detail, /already passing on current state/);
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

test('hooks install then undo: the shims go and core.hooksPath goes back to unset', async () => {
  // The VERIFIED defect of review 0003 Q22: `undo` removed the shims but left
  // `core.hooksPath` pointing at their empty directory, so the repository's
  // own hooks silently stopped running.
  const root = await fixture({ manifest: { gates: { preCommit: ['lint'], prePush: ['test'] } } });
  await simt(['init', '--root', root, '--yes'], root).catch(() => {});
  await simt(['hooks', 'install', '--root', root, '--yes'], root);
  const { stdout } = await exec('git', ['config', '--get', HOOKS_PATH_KEY], { cwd: root });
  assert.equal(stdout.trim(), HOOKS_DIR);

  const preview = await simt(['undo', '--root', root], root);
  assert.match(preview.stdout, /git config core\.hooksPath/);
  const undone = await simt(['undo', '--root', root, '--yes'], root);
  assert.match(undone.stdout, /undone/);

  await assert.rejects(exec('git', ['config', '--get', HOOKS_PATH_KEY], { cwd: root }), (error) => error.code === 1);
  for (const event of EVENTS) {
    await assert.rejects(readFile(join(root, fileFor(event)), 'utf8'), `the ${event} shim survived its own undo`);
  }
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
  assert.match(stdout, /UNCHANGED .simt\/hooks\/post-commit/);
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
