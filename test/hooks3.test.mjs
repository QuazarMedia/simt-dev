import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readdir, readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';

import { PACKAGE_NAME } from '../src/name.mjs';
import { test } from 'node:test';

import { GATE_KINDS, GATES, FORMATTABLE, gateNames } from '../src/hooks/gates.mjs';
import { EVENTS, HOOKS_DIR, HOOKS_DIR_LEGACY, HOOKS_PATH_KEY, SHIM_MARKER, fileFor, renderChainedShim, renderShim } from '../src/hooks/shim.mjs';
import { hasScript, resolveGate, resolveStagedTool } from '../src/hooks/resolve.mjs';
import { classifyPush, parsePushedRefs, renderGateReport, runGates, stagedFiles } from '../src/hooks/dispatcher.mjs';
import { recordRun } from '../src/ledger/index.mjs';
import { packageVersion } from '../src/package-version.mjs';
import { readCapability } from '../src/hooks/capability.mjs';
import * as gateModule from '../src/projection/manifest.mjs';
import { git, cmd, keepTemp } from './fixture.mjs';
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

async function fixture({ scripts, manifest, files = {}, binaries = [], formatter = false } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'simt-hooksd-'));
  keepTemp(root);
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

test('hooks status: a current chained shim is reported present, not stale', async () => {
  // The other half of the pre-push defect above: the chain shim was compared against
  // the dispatcher template, so a freshly installed one read as stale forever and no
  // reinstall could clear it. A chain shim's currency is its target, not the
  // dispatcher bytes.
  const root = await fixture({
    manifest: { gates: { preCommit: ['lint'], prePush: [] }, commands: {} },
    scripts: { lint: 'true' },
    files: { '.git/hooks/pre-push': '#!/bin/sh\nexit 0\n' },
  });
  await chmod(join(root, '.git', 'hooks', 'pre-push'), 0o755);
  await simt(['hooks', 'install', '--root', root, '--yes'], root);

  const { stdout } = await simt(['hooks', 'status', '--root', root], root);
  assert.match(stdout, /^PRESENT  pre-push\s+executable=true$/m, stdout);
  assert.doesNotMatch(stdout, /differs from this simt-dev/);
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
//   stopped running pre-commit at .simt\/hooks/pre-commit (2565 bytes); the file is
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
  // makes it stale. A 0.1.x shim is exactly this - same banner, older locator: its
  // resolution list had three lines (the command was still spelled simt-dev, and there
  // was no .simt/bin path yet), so the last line moves from position 4 to 3.
  const path = join(root, fileFor('pre-commit'));
  const current = await readFile(path, 'utf8');
  const aged = current.replace('#   4. simt on PATH', '#   3. simt-dev on PATH');
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

  assert.match(stdout, /REMOVED\s+.simt\/hooks\/pre-push/, stdout);
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

  assert.match(stdout, /REMOVED\s+.simt\/hooks\/pre-commit/, stdout);
  // The routing goes too. core.hooksPath tells git to read ONE directory for EVERY
  // event, so leaving it pointed at an empty directory stops the repository's own
  // .git/hooks scripts running - silently, which is why the plan has to say so.
  assert.match(stdout, /core\.hooksPath\s+removed/, stdout);
  assert.equal(await hooksPath(root), null, 'core.hooksPath was not unset');
  assert.deepEqual(await readdir(join(root, HOOKS_DIR)), [], 'a shim survived');
});

test('hooks install: a plan that removes the last shim says it un-routes, in prose and in JSON', async () => {
  // A plan printing "core.hooksPath updated .simt\/hooks -> .simt\/hooks" while the
  // command unsets it is worse than no plan, and the `--json` payload promising a
  // directory the command is about to clear is the same lie in a shape a machine reads.
  const root = await installedRepo({ preCommit: ['lint'], prePush: ['test'] });
  await setManifest(root, { preCommit: [], prePush: [] });

  const dry = await simt(['hooks', 'install', '--root', root], root);
  assert.match(dry.stdout, /core\.hooksPath\s+removed\s+.simt\/hooks -> \(unset\)/, dry.stdout);
  assert.doesNotMatch(dry.stdout, /-> .simt\/hooks\s*$/, dry.stdout);

  const { stdout } = await simt(['hooks', 'install', '--root', root, '--json'], root);
  const payload = JSON.parse(stdout);
  assert.equal(payload.wouldSet, null, payload);
  assert.deepEqual(
    payload.plan.map((p) => `${p.file}:${p.action}`),
    ['.simt\/hooks/pre-commit:removed', '.simt\/hooks/pre-push:removed'],
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

test('hooks install: a legacy shim directory of its own files removes itself (ADR-122)', async () => {
  // The move into the state directory is self-healing in a repository installed
  // before it: the install re-routes git to .simt\/hooks, and the old top-level
  // directory is then the only place that looks like a hooks directory while
  // holding nothing git reads. Every file in it is a simt-dev shim, so the
  // install takes it down - journaled, and announced in the plan first.
  const root = await installedRepo({ preCommit: ['lint'], prePush: ['test'] });
  const legacy = join(root, HOOKS_DIR_LEGACY);
  await mkdir(legacy, { recursive: true });
  const legacyShim = join(legacy, 'pre-commit');
  await writeFile(legacyShim, `${SHIM_MARKER}\nexit 0\n`);
  await chmod(legacyShim, 0o755);

  const dry = await simt(['hooks', 'install', '--root', root], root);
  assert.match(dry.stdout, new RegExp(`REMOVED\\s+${HOOKS_DIR_LEGACY}\\b`), dry.stdout);
  assert.ok(existsSync(legacy), 'the preview wrote: it must only plan the removal');

  const run = await simt(['hooks', 'install', '--root', root, '--yes'], root);
  const out = run.stdout + run.stderr;
  assert.match(out, new RegExp(`REMOVED\\s+${HOOKS_DIR_LEGACY}\\b`), out);
  assert.equal(existsSync(legacy), false, 'the legacy directory is still on disk');
  // The move did not disturb the routing or the new shims.
  assert.equal(await hooksPath(root), HOOKS_DIR);
  assert.ok(await readFile(join(root, HOOKS_DIR, 'pre-commit'), 'utf8'), 'a new-location shim went missing');
});

test('hooks install: a legacy directory holding a file it did not write is left in place (ADR-122)', async () => {
  // The marker check is what makes the removal safe: one file without a
  // simt-dev marker is proof the directory is not exclusively this tool's, and
  // a directory this tool does not exclusively own is not deleted on its way.
  const root = await installedRepo({ preCommit: ['lint'], prePush: ['test'] });
  const legacy = join(root, HOOKS_DIR_LEGACY);
  await mkdir(legacy, { recursive: true });
  const mine = join(legacy, 'mine');
  await writeFile(mine, '#!/bin/sh\necho hi\n');
  await chmod(mine, 0o755);

  const run = await simt(['hooks', 'install', '--root', root, '--yes'], root);
  const out = run.stdout + run.stderr;
  // No plan entry for a directory the install is not removing: the plan names
  // only what changes, and the foreign file is the reason nothing changes.
  assert.doesNotMatch(out, /REMOVED\s+\.simt\-hooks/, out);
  assert.ok(existsSync(mine), 'a file this tool did not write was deleted with its directory');
  assert.equal(await hooksPath(root), HOOKS_DIR, 'the routing was disturbed by a directory it left alone');
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

  assert.match(stdout, /REMOVED\s+.simt\/hooks\/pre-commit/, stdout);
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
  // too. Chaining it wrote `.simt\/hooks/<name>` with TARGET `.simt\/hooks/<name>` - the
  // same path - so the shim overwrote the hook it was written to preserve and then ran
  // itself. The previous release printed `UPDATED .simt\/hooks/mine (chained: runs
  // .simt\/hooks/mine)` and exited 0.
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
  assert.match(stdout, /REMOVED\s+.simt\/hooks\/pre-commit|UNCHANGED\s+.simt\/hooks\/pre-commit/, stdout);
});

test('hooks install: a hand-written file NAMED for a gated event is not deleted either', async () => {
  // The case the authorship check exists for, which the other test cannot reach.
  // `state.installed` iterates the two events this tool gates, so a file at
  // `.simt\/hooks/mine` is not in that list at all and the filter never sees it. The
  // guard is for a file at `.simt\/hooks/pre-commit` that a person wrote by hand -
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
  assert.doesNotMatch(planOnly, /.simt\/hooks\/pre-commit/, `plan touched a file this tool did not write:\n${stdout}`);
  // The one it DID write is still removed, so this is not a blanket refusal.
  await assert.rejects(() => readFile(join(root, fileFor('pre-push')), 'utf8'), 'the shim for the dropped gate survived');
});
