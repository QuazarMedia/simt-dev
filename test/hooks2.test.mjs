import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readFile, realpath, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';

import { PACKAGE_NAME } from '../src/name.mjs';
import { after, test } from 'node:test';

import { GATE_KINDS, GATES, FORMATTABLE, gateNames } from '../src/hooks/gates.mjs';
import { EVENTS, HOOKS_DIR, HOOKS_DIR_LEGACY, HOOKS_PATH_KEY, SHIM_MARKER, fileFor, renderChainedShim, renderShim } from '../src/hooks/shim.mjs';
import { hasScript, resolveGate, resolveStagedTool } from '../src/hooks/resolve.mjs';
import { classifyPush, DEFAULT_SKIP_EXTENSIONS, parsePushedRefs, renderGateReport, runGates, stagedFiles } from '../src/hooks/dispatcher.mjs';
import { recordRun } from '../src/ledger/index.mjs';
import { packageVersion } from '../src/package-version.mjs';
import { readCapability } from '../src/hooks/capability.mjs';
import * as gateModule from '../src/projection/manifest.mjs';
import { git, cmd, keepTemp } from './fixture.mjs';
import { CLI } from '../src/name.mjs';
import { MANIFEST_FILE } from '../src/name.mjs';
import { simt as simtCli } from './fixture.mjs';

import { run, exec, BIN, fixture, stageBlob, stagedContent, simt, simtAllowingFailure, SKIP_TEST, twoCommitPush, recordGreenSuite, installedRepo, setManifest, hooksPath } from './hooks2-fixture.mjs';
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

test('the built-in extension set is the image and document kinds, and a change needs a test edit', () => {
  // A manifest without `extensions` applies this set (ADR-147). Pinning it here means a
  // kind added or dropped from the default is visible in the diff, not only in a push
  // that suddenly stops skipping.
  assert.deepEqual(DEFAULT_SKIP_EXTENSIONS, [
    'avif', 'bmp', 'gif', 'heic', 'heif', 'ico', 'jpeg', 'jpg', 'png', 'svg', 'tif', 'tiff', 'webp',
    'doc', 'docx', 'epub', 'md', 'odt', 'pdf', 'rtf', 'txt',
  ]);
});

test('dispatcher: a tag riding a non-code branch push skips the test gate', async () => {
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
  // Commits are being delivered, so the push kind stays non-code even with a tag aboard.
  assert.match(gate.detail, /^non-code push: 1 commit\(s\) touching 1 file\(s\)/);
  assert.match(gate.detail, /1 tag\(s\) already delivered/);
});

test('dispatcher: image and document files skip the test gate without a declared extension list', async () => {
  const manifest = { gates: { preCommit: [], prePush: ['test'], prePushSkipTest: { maxCommits: 2, paths: ['docs/**'] } } };
  const { root, pushed } = await twoCommitPush({
    files: { 'base.md': 'a\n' },
    topFiles: { 'res/shot.png': 'img\n', 'notes.txt': 'b\n' },
    manifest,
  });
  const result = await runGates('pre-push', { root, manifest, pushed });
  const gate = result.gates.find((g) => g.name === 'test');
  assert.equal(gate.status, 'skipped');
  // Neither file matches the declared path; both sit in the built-in image-and-document set.
  assert.match(gate.detail, /non-code push: 1 commit\(s\) touching 2 file\(s\)/);
});

test('dispatcher: a declared extension list replaces the built-in set, never unions with it', async () => {
  const manifest = { gates: { preCommit: [], prePush: ['test'], prePushSkipTest: { maxCommits: 2, paths: ['docs/**'], extensions: ['txt'] } } };
  const { root, pushed } = await twoCommitPush({
    files: { 'base.md': 'a\n' },
    topFiles: { 'notes.txt': 'b\n', 'res/shot.png': 'img\n' },
    manifest,
  });
  const result = await runGates('pre-push', { root, manifest, pushed });
  // `txt` is declared; `png` sits in the built-in set only, so a union would skip and a
  // replacement runs the suite.
  assert.equal(result.gates.find((g) => g.name === 'test').status, 'passed');
});

test('dispatcher: a misshaped extension list fails closed to the test gate', async () => {
  for (const bad of [5, '', ['ok', '']]) {
    const manifest = { gates: { preCommit: [], prePush: ['test'], prePushSkipTest: { maxCommits: 2, paths: ['docs/**'], extensions: bad } } };
    const { root, pushed } = await twoCommitPush({ files: { 'base.md': 'a\n' }, topFiles: { 'notes.txt': 'b\n' }, manifest });
    const result = await runGates('pre-push', { root, manifest, pushed });
    assert.equal(result.gates.find((g) => g.name === 'test').status, 'passed', `extensions: ${JSON.stringify(bad)}`);
  }
});

test('dispatcher: a declared res path covers a file no extension set contains', async () => {
  const manifest = { gates: { preCommit: [], prePush: ['test'], prePushSkipTest: { maxCommits: 2, paths: ['res/**', 'docs/**'] } } };
  const { root, pushed } = await twoCommitPush({
    files: { 'base.md': 'a\n' },
    topFiles: { 'res/data.csv': '1,2\n' },
    manifest,
  });
  const result = await runGates('pre-push', { root, manifest, pushed });
  const gate = result.gates.find((g) => g.name === 'test');
  assert.equal(gate.status, 'skipped');
  // `csv` is in no extension set; the declared path is what earns the skip.
  assert.match(gate.detail, /non-code push: 1 commit\(s\) touching 1 file\(s\)/);
});

test('dispatcher: a five-commit push within a declared five-commit ceiling skips the test gate', async () => {
  const manifest = { gates: { preCommit: [], prePush: ['test'], prePushSkipTest: { maxCommits: 5, paths: ['docs/**'] } } };
  const root = await fixture({ scripts: { test: 'exit 0' }, files: { 'a.md': '1\n' }, manifest });
  await git(['add', '-A'], { cwd: root });
  await git(['commit', '-m', 'base'], { cwd: root });
  const { stdout: base } = await exec('git', ['rev-parse', 'HEAD'], { cwd: root });
  for (let i = 1; i <= 5; i += 1) {
    await writeFile(join(root, `note-${i}.txt`), `${i}\n`);
    await git(['add', '-A'], { cwd: root });
    await git(['commit', '-m', `note-${i}`], { cwd: root });
  }
  const { stdout: head } = await exec('git', ['rev-parse', 'HEAD'], { cwd: root });
  const pushed = `refs/heads/main ${head.trim()} refs/heads/main ${base.trim()}\n`;
  const result = await runGates('pre-push', { root, manifest, pushed });
  const gate = result.gates.find((g) => g.name === 'test');
  assert.equal(gate.status, 'skipped');
  assert.match(gate.detail, /5 commit\(s\) touching 5 file\(s\)/);
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

test('dispatcher: a code push skips on evidence when present', async () => {
  // With prePushSkipTest declared, a code push is not non-code, so the non-code path yields
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

