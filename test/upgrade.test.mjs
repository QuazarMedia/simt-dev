// simt-dev upgrade - moving a pin across many repositories.
//
// Every test runs the tool the way a CONSUMER runs it. The failure this file exists to
// prevent is a command that only works from its own source tree, or that quietly writes
// something it did not report. So each test adopts real repositories with `simt-dev init`,
// pins them at a known SHA, and then checks what `upgrade` did to the FILES.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, cp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { planUpgrade, summariseUpgrade } from '../src/upgrade/plan.mjs';
import { initCommand } from '../src/commands/init.mjs';
import { upgradeCommand } from '../src/commands/upgrade.mjs';
import { git } from './fixture.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const BIN = resolve(HERE, '..', 'bin', 'simt-dev.mjs');
const exec = promisify(execFile);

// The third argument exists for one test: running the tool out of a package nested
// INSIDE the repository being tested, which is the npm layout. That is the only way to
// reproduce a stamp that borrows the consumer's own git — from this checkout the stamp
// would come from simt-dev's repository, which is the right answer for the wrong reason,
// and the test would pass against the very defect it exists to catch.
async function run(args, env = {}, bin = BIN) {
  try {
    const { stdout, stderr } = await exec('node', [bin, ...args], { maxBuffer: 32 << 20, env: { ...process.env, ...env } });
    return { code: 0, stdout, stderr };
  } catch (error) {
    return { code: error.code ?? 1, stdout: error.stdout ?? '', stderr: error.stderr ?? '' };
  }
}

async function runJson(args, env = {}, bin = BIN) {
  const { code, stdout } = await run([...args, '--json'], env, bin);
  return { code, payload: JSON.parse(stdout) };
}

/** A git repo with enough markers for `init` to detect a stack. */
async function repo(path, files) {
  await mkdir(path, { recursive: true });
  await exec('git', ['init', '-q', path]);
  for (const [name, body] of Object.entries(files)) {
    const full = join(path, name);
    await mkdir(dirname(full), { recursive: true });
    await writeFile(full, body);
  }
  return path;
}

async function readJson(path) {
  return JSON.parse(await readFile(path, 'utf8'));
}

async function pin(path, sha) {
  const full = join(path, 'simt-dev.json');
  const manifest = await readJson(full);
  manifest.projection.simtDevSha = sha;
  await writeFile(full, `${JSON.stringify(manifest, null, 2)}\n`);
  return manifest;
}

/** The short sha a commit in `path` produced, read back from git rather than assumed. */
async function consumerHead(path) {
  const { stdout } = await exec('git', ['rev-parse', '--short=7', 'HEAD'], { cwd: path });
  return stdout.trim();
}

// --- the classifier (pure) ------------------------------------------------------

const TARGET = { file: 'AGENTS.md', action: 'unchanged', previousBytes: 500, bytes: 500 };

test('upgrade plan: a repo with no manifest is not-adopted, not behind', () => {
  const p = planUpgrade({
    name: 'x',
    path: '/x',
    manifest: null,
    manifestExists: false,
    manifestError: null,
    targets: [TARGET],
    sha: 'aaaaaaa',
  });
  assert.equal(p.state, 'not-adopted');
  assert.equal(p.action, 'skip');
  // The remedy must name the command that actually adopts a repo. "behind" would
  // suggest this command could fix it, and it cannot.
  assert.equal(p.remedy, 'simt-dev init');
});

test('upgrade plan: a stale pin alone is an update, and says the region was fine', () => {
  const p = planUpgrade({
    name: 'x',
    path: '/x',
    manifest: { projection: { simtDevSha: '0000000' } },
    manifestExists: true,
    manifestError: null,
    targets: [TARGET],
    sha: 'aaaaaaa',
  });
  assert.equal(p.action, 'updated');
  assert.match(p.detail, /region was already current/);
});

test('upgrade plan: changed rules alone are an update, and says the pin was fine', () => {
  const p = planUpgrade({
    name: 'x',
    path: '/x',
    manifest: { projection: { simtDevSha: 'aaaaaaa' } },
    manifestExists: true,
    manifestError: null,
    targets: [{ ...TARGET, action: 'updated' }],
    sha: 'aaaaaaa',
  });
  assert.equal(p.action, 'updated');
  assert.match(p.detail, /pin was already current/);
});

test('upgrade plan: a malformed region is skipped, never written over', () => {
  const p = planUpgrade({
    name: 'x',
    path: '/x',
    manifest: { projection: { simtDevSha: '0000000' } },
    manifestExists: true,
    manifestError: null,
    targets: [
      { ...TARGET, action: 'malformed', reason: 'begin marker with no matching end marker', line: 4 },
    ],
    sha: 'aaaaaaa',
  });
  assert.equal(p.action, 'skip');
  assert.equal(p.state, 'malformed-region');
  assert.match(p.remedy, /AGENTS\.md:4/);
});

test('upgrade plan: a manifest with no region is a repair, not a version bump', () => {
  const p = planUpgrade({
    name: 'x',
    path: '/x',
    manifest: { projection: { simtDevSha: '0000000' } },
    manifestExists: true,
    manifestError: null,
    targets: [{ file: 'AGENTS.md', action: 'added', previousBytes: 0, bytes: 500 }],
    sha: 'aaaaaaa',
  });
  assert.equal(p.action, 'skip');
  // The remedy has to carry `--yes`. `sync` previews unless told to write, so a
  // remedy naming the bare command would tell the reader to run it and watch
  // nothing happen — the instruction survives the change that made it false.
  assert.equal(p.remedy, 'run: simt-dev sync --yes');
});

test('upgrade plan: an unparseable manifest is skipped, not overwritten', () => {
  const p = planUpgrade({
    name: 'x',
    path: '/x',
    manifest: null,
    manifestExists: true,
    manifestError: 'unparseable: Unexpected token',
    targets: [TARGET],
    sha: 'aaaaaaa',
  });
  assert.equal(p.action, 'skip');
  assert.equal(p.state, 'broken-manifest');
});

test('summariseUpgrade: counts each outcome and names the distinct skip reasons', () => {
  const skip = (state) => ({ state, action: 'skip' });
  const s = summariseUpgrade([
    { state: 'current', action: 'unchanged' },
    { state: 'behind', action: 'updated' },
    { state: 'behind', action: 'updated' },
    skip('not-adopted'),
    skip('malformed-region'),
    skip('not-adopted'),
  ]);
  assert.deepEqual(s, {
    repos: 6,
    updated: 2,
    unchanged: 1,
    skipped: 3,
    faults: 1,
    skippedStates: ['malformed-region', 'not-adopted'],
  });
});

// --- end to end -----------------------------------------------------------------

test('upgrade: moves the pin and the region together, then check agrees', async () => {
  const ws = await mkdtemp(join(tmpdir(), 'simt-up-'));
  await repo(join(ws, 'alpha'), { 'requirements.txt': 'flask\n' });
  await repo(join(ws, 'beta'), { 'package.json': '{"name":"beta"}\n' });

  for (const name of ['alpha', 'beta']) await run(['init', '--root', join(ws, name), '--yes']);
  await pin(join(ws, 'alpha'), '0000000');
  await pin(join(ws, 'beta'), '0000000');

  // Dry run first, and prove it changed nothing.
  const dry = await runJson(['upgrade', '--workspace', ws]);
  assert.equal(dry.payload.summary.updated, 2);
  assert.equal(dry.payload.written, false);
  assert.equal((await readJson(join(ws, 'alpha', 'simt-dev.json'))).projection.simtDevSha, '0000000');

  const sha = dry.payload.sha;
  const done = await runJson(['upgrade', '--workspace', ws, '--yes']);
  assert.equal(done.code, 0);
  assert.equal(done.payload.summary.updated, 2);

  // Both halves of the pin moved. A region restamped with a manifest still claiming the
  // old SHA is the state that makes `compare` report a mismatch that is not real.
  for (const name of ['alpha', 'beta']) {
    assert.equal((await readJson(join(ws, name, 'simt-dev.json'))).projection.simtDevSha, sha);
    const agents = await readFile(join(ws, name, 'AGENTS.md'), 'utf8');
    assert.ok(agents.includes(`simt-dev:sha=${sha}`), `${name} region was not restamped`);
    assert.equal((await run(['check', '--root', join(ws, name)])).code, 0);
  }
});

test('upgrade: a second run changes nothing', async () => {
  const ws = await mkdtemp(join(tmpdir(), 'simt-up-'));
  await repo(join(ws, 'alpha'), { 'requirements.txt': 'flask\n' });
  await run(['init', '--root', join(ws, 'alpha'), '--yes']);
  await pin(join(ws, 'alpha'), '0000000');

  await run(['upgrade', '--workspace', ws, '--yes']);
  const before = await readFile(join(ws, 'alpha', 'AGENTS.md'), 'utf8');

  const again = await runJson(['upgrade', '--workspace', ws]);
  assert.equal(again.code, 0);
  assert.deepEqual(
    { updated: again.payload.summary.updated, unchanged: again.payload.summary.unchanged },
    { updated: 0, unchanged: 1 },
  );
  assert.equal(await readFile(join(ws, 'alpha', 'AGENTS.md'), 'utf8'), before);
});

test('upgrade: a malformed region is reported and the run fails, leaving bytes alone', async () => {
  const ws = await mkdtemp(join(tmpdir(), 'simt-up-'));
  await repo(join(ws, 'beta'), { 'package.json': '{"name":"beta"}\n' });
  await run(['init', '--root', join(ws, 'beta'), '--yes']);
  await pin(join(ws, 'beta'), '0000000');
  const agents = join(ws, 'beta', 'AGENTS.md');
  const broken = (await readFile(agents, 'utf8')).replace('<!-- simt-dev:end -->', '');
  await writeFile(agents, broken);

  const { code, payload } = await runJson(['upgrade', '--workspace', ws, '--yes']);
  assert.equal(code, 1, 'a broken repo must fail the run, not pass quietly');
  assert.equal(payload.summary.updated, 0);
  assert.equal(payload.summary.faults, 1);
  assert.deepEqual(payload.summary.skippedStates, ['malformed-region']);
  assert.equal(await readFile(agents, 'utf8'), broken, 'a malformed region must not be rewritten');
  // The manifest is untouched too: writing the pin would make `compare` report a
  // mismatch against a region that does not exist.
  assert.equal((await readJson(join(ws, 'beta', 'simt-dev.json'))).projection.simtDevSha, '0000000');
});

test('upgrade: an unadopted repo in the set is skipped, not adopted', async () => {
  const ws = await mkdtemp(join(tmpdir(), 'simt-up-'));
  await repo(join(ws, 'adopted'), { 'requirements.txt': 'flask\n' });
  await repo(join(ws, 'fresh'), { 'package.json': '{"name":"fresh"}\n' });
  await run(['init', '--root', join(ws, 'adopted'), '--yes']);
  await pin(join(ws, 'adopted'), '0000000');

  const { code, payload } = await runJson(['upgrade', '--workspace', ws, '--yes']);
  assert.equal(code, 0, 'a repo that never adopted is expected, not a fault');
  assert.equal(payload.summary.updated, 1);
  assert.equal(payload.summary.faults, 0);
  assert.deepEqual(payload.summary.skippedStates, ['not-adopted']);
  await assert.rejects(readFile(join(ws, 'fresh', 'simt-dev.json')), 'upgrade must not adopt a repo');
});

test('upgrade: simt-dev itself is not a consumer and round-trips as a no-op', async () => {
  // The acceptance criterion in plan 0002 section 11. simt-dev has no manifest, so the
  // command must report that rather than stamp a pin into the repo that produces pins.
  //
  // The invariant is "simt-dev is not a consumer of itself", and it is asserted here
  // as "no simt-dev.json appears" rather than as a particular summary. Asserting the
  // summary meant asserting a `repos: 1`, and `repos: 1` is only reachable when this
  // checkout happens to BE a git repo: a `.git`-less copy (a tarball, `git archive`,
  // the published package itself) is a directory holding no repositories, which
  // `discover` refuses with exit 3 and a remedy. Both answers are correct, so the
  // test asserted a property of the author's directory and failed for anyone whose
  // clone is not a repo. ADR-031 is the same defect one level up.
  const root = resolve(HERE, '..');
  await assert.rejects(readFile(join(root, 'simt-dev.json')), 'simt-dev must not be its own consumer');
  const { code } = await run(['upgrade', '--root', root, '--yes']);
  assert.ok(code === 0 || code === 3, `expected a no-op or a refusal, got exit ${code}`);
  await assert.rejects(readFile(join(root, 'simt-dev.json')), 'upgrade stamped a pin into simt-dev');
});

test('upgrade: a commit in the CONSUMER repo does not move the stamp', async () => {
  // The defect review 0002 recorded as probe #2, and the one the suite could not see:
  // `git rev-parse` run inside `node_modules/` walks UP to the consumer's own `.git`, so
  // the stamp recorded the consumer's HEAD. Git succeeded, so no fallback could catch it.
  // A consumer's HEAD moves on every commit they make — including commits that touch
  // nothing this tool projects — so `check` reported DRIFT on all three generated files
  // and exited 1 after an unrelated commit, and `upgrade` reported a pin move and named
  // "the rules changed", which was false.
  //
  // Running the tool out of this checkout cannot reproduce it: here `git rev-parse` finds
  // simt-dev's own HEAD, which is the correct answer for the wrong reason. So the test
  // stages the npm layout — the package nested INSIDE the consumer's repository — because
  // that arrangement is the entire audience for a published package.
  const ws = await mkdtemp(join(tmpdir(), 'simt-consumer-'));
  const consumer = join(ws, 'repo');
  const pkg = join(consumer, 'node_modules', '@acme', 'simt-dev');
  await mkdir(pkg, { recursive: true });
  for (const name of ['bin', 'src', 'rules', 'graph']) {
    await cp(join(resolve(HERE, '..'), name), join(pkg, name), { recursive: true });
  }
  await cp(join(resolve(HERE, '..'), 'package.json'), join(pkg, 'package.json'));

  await repo(consumer, { 'requirements.txt': 'flask\n' });
  await git(['add', '-A'], { cwd: consumer });
  await git(['commit', '-m', 'the repo before adopting'], { cwd: consumer });
  const nested = join(pkg, 'bin', 'simt-dev.mjs');
  const adopted = await run(['init', '--root', consumer, '--yes'], {}, nested);
  assert.equal(adopted.code, 0, adopted.stderr);
  const consumersHead = await consumerHead(consumer);
  const stamp = /simt-dev:sha=([0-9a-f]{7,40})/.exec(await readFile(join(consumer, 'AGENTS.md'), 'utf8'))[1];
  assert.notEqual(
    stamp,
    consumersHead,
    'the stamp recorded the consumer\'s HEAD, which is the walk-up defect',
  );

  // A commit that changes nothing this tool projects.
  await writeFile(join(consumer, 'NOTES.md'), '# an unrelated note\n');
  await git(['add', '-A'], { cwd: consumer });
  await git(['commit', '-m', 'an unrelated note'], { cwd: consumer });
  assert.notEqual(await consumerHead(consumer), consumersHead, 'the fixture commit did not happen');

  const gated = await run(['check', '--root', consumer], {}, nested);
  assert.equal(gated.code, 0, `an unrelated consumer commit turned the gate red:\n${gated.stdout}`);

  // And the pin holds, rather than reporting a move it never made.
  const { code, payload } = await runJson(['upgrade', '--root', consumer], {}, nested);
  assert.equal(code, 0, 'upgrade refused a repo it had just adopted');
  assert.equal(payload.summary.updated, 0, JSON.stringify(payload.summary));
  assert.deepEqual(payload.summary.skippedStates, [], JSON.stringify(payload.summary));
});

test('upgrade: --root on one repo upgrades that repo, not its siblings', async () => {
  const ws = await mkdtemp(join(tmpdir(), 'simt-up-'));
  await repo(join(ws, 'alpha'), { 'requirements.txt': 'flask\n' });
  await repo(join(ws, 'beta'), { 'package.json': '{"name":"beta"}\n' });
  for (const name of ['alpha', 'beta']) {
    await run(['init', '--root', join(ws, name), '--yes']);
    await pin(join(ws, name), '0000000');
  }

  const { code, payload } = await runJson(['upgrade', '--root', join(ws, 'alpha'), '--yes']);
  assert.equal(code, 0);
  assert.equal(payload.shape, 'repo');
  assert.equal(payload.summary.repos, 1);
  assert.notEqual((await readJson(join(ws, 'alpha', 'simt-dev.json'))).projection.simtDevSha, '0000000');
  assert.equal((await readJson(join(ws, 'beta', 'simt-dev.json'))).projection.simtDevSha, '0000000');
});

test('upgrade: --all without a workspace fails instead of quietly scoping to one repo', async () => {
  // "All" of nothing is a contradiction. Defaulting it to the current directory would
  // make the flag mean nothing at all.
  const { code, stdout, stderr } = await run(['upgrade', '--all'], { SIMT_DEV_WORKSPACE: 'off' });
  assert.equal(code, 3);
  assert.match(stderr, /--all needs a workspace/);
  assert.equal(stdout, '');
});

test('upgrade: a worktree is reported but never stamped', async () => {
  const ws = await mkdtemp(join(tmpdir(), 'simt-up-'));
  await repo(join(ws, 'alpha'), { 'requirements.txt': 'flask\n' });
  await run(['init', '--root', join(ws, 'alpha'), '--yes']);
  await pin(join(ws, 'alpha'), '0000000');
  await git(['-C', join(ws, 'alpha'), 'commit', '-q', '--allow-empty', '-m', 'init']);

  await exec('git', ['-C', join(ws, 'alpha'), 'worktree', 'add', '-q', join(ws, 'wt'), '-b', 'wt']);
  const { payload } = await runJson(['upgrade', '--workspace', ws, '--yes']);
  assert.equal(payload.summary.repos, 1, 'the worktree is not an independent consumer');
});

test('upgrade: never commits or pushes (ADR-001)', async () => {
  const ws = await mkdtemp(join(tmpdir(), 'simt-up-'));
  await repo(join(ws, 'alpha'), { 'requirements.txt': 'flask\n' });
  await run(['init', '--root', join(ws, 'alpha'), '--yes']);
  await pin(join(ws, 'alpha'), '0000000');
  const before = await exec('git', ['-C', join(ws, 'alpha'), 'rev-list', '--count', 'HEAD']).catch(() => ({ stdout: '0' }));

  await run(['upgrade', '--workspace', ws, '--yes']);
  const after = await exec('git', ['-C', join(ws, 'alpha'), 'rev-list', '--count', 'HEAD']).catch(() => ({ stdout: '0' }));
  assert.equal(String(before.stdout ?? '').trim(), String(after.stdout ?? '').trim());
  const { stdout } = await exec('git', ['-C', join(ws, 'alpha'), 'status', '--porcelain']);
  assert.match(stdout, /simt-dev\.json/, 'the changes are left uncommitted for the human to review');
});
// --- upgrade restamps every generated file, not only AGENTS.md -----------------

// These two tests use copilot rather than cursor for the per-rule file, and that is
// ADR-046: cursor reads AGENTS.md, so it is no longer planned a file at all and a
// fixture built on it would have nothing to make stale or repair. The property under
// test is unchanged - a generated rule file is repaired wholesale, a malformed region
// in a file the repo also hand-writes is a fault that stops the run.
test('upgrade: a current AGENTS.md with stale .mdc rules is still behind', async () => {
  // The defect this test exists for. `upgrade` planned and wrote `targets[0]` only, so a
  // repo whose AGENTS.md region was current but whose three `.mdc` rules were stale was
  // reported "restamped" while three of its four generated files stayed behind - and
  // `check` was red immediately after a successful upgrade.
  const root = await mkdtemp(join(tmpdir(), 'simt-up-mdc-'));
  const a = await repo(join(root, 'a'), { 'wrangler.jsonc': '{"name":"a"}' });
  // A second surface is opted into so the repo really does have several generated
  // files. The default surface folds every rule into AGENTS.md, and one file cannot
  // prove that `upgrade` restamps all of them.
  const adopted = await run(['init', a, '--yes', '--surfaces', 'opencode,copilot']);
  assert.equal(adopted.code, 0, adopted.stderr);
  await pin(a, 'aaaaaaa');

  // Rewind only the `.mdc` rules to a stale SHA, leaving AGENTS.md current.
  const mdc = join(a, '.github/instructions/test-gate.instructions.md');
  const stale = (await readFile(mdc, 'utf8')).replace(/simt-dev:sha=[0-9a-f]+/, 'simt-dev:sha=aaaaaaa');
  await writeFile(mdc, stale);
  const agentsSha = /simt-dev:sha=[0-9a-f]+/.exec(await readFile(join(a, 'AGENTS.md'), 'utf8'))[0];
  const agentsNow = /simt-dev:sha=[0-9a-f]+/.exec(await readFile(join(a, 'AGENTS.md'), 'utf8'))[0];
  assert.equal(agentsSha, agentsNow);

  const before = await runJson(['upgrade', '--root', a]);
  assert.equal(before.payload.summary.updated, 1, JSON.stringify(before.payload.summary));

  const applied = await run(['upgrade', '--root', a, '--yes']);
  assert.equal(applied.code, 0, applied.stderr);

  // Every generated file now carries the current SHA, not just AGENTS.md.
  const head = /simt-dev:sha=[0-9a-f]+/.exec(agentsNow)[0].replace('simt-dev:sha=', '');
  const afterMdc = /simt-dev:sha=[0-9a-f]+/.exec(await readFile(mdc, 'utf8'))[0];
  assert.equal(afterMdc, `simt-dev:sha=${head}`, 'the .mdc rule was left behind');
  assert.equal((await run(['check', '--root', a])).code, 0, 'check is red after a successful upgrade');
});

test('upgrade: a malformed AGENTS.md is a fault, while a malformed .mdc rule is repaired', async () => {
  // The two are not the same fault, and conflating them would be wrong in both
  // directions. A managed `.mdc` rule is a generated file: a malformed region there is
  // replaced wholesale and nothing hand-owned is lost. AGENTS.md holds hand-written prose
  // around the region, so overwriting it could destroy work - it is a fault, the run
  // fails, and nothing is written anywhere in the repo.
  const root = await mkdtemp(join(tmpdir(), 'simt-up-bad-'));
  const a = await repo(join(root, 'a'), { 'wrangler.jsonc': '{"name":"a"}' });
  assert.equal((await run(['init', a, '--yes', '--surfaces', 'opencode,copilot'])).code, 0);
  await pin(a, 'aaaaaaa');

  // A broken .mdc region is repaired by the write, because the whole file is generated.
  const mdc = join(a, '.github/instructions/test-gate.instructions.md');
  await writeFile(mdc, (await readFile(mdc, 'utf8')).replace('<!-- simt-dev:end -->', ''));
  assert.equal((await run(['upgrade', '--root', a, '--yes'])).code, 0);
  assert.equal((await run(['check', '--root', a])).code, 0, 'the broken rule was not repaired');

  // A broken AGENTS.md region is a fault, and nothing is written.
  await pin(a, 'aaaaaaa');
  const agents = join(a, 'AGENTS.md');
  await writeFile(agents, (await readFile(agents, 'utf8')).replace('<!-- simt-dev:end -->', ''));
  const mdcBefore = await readFile(mdc, 'utf8');
  const { payload } = await runJson(['upgrade', '--root', a]);
  assert.equal(payload.summary.faults, 1);
  assert.deepEqual(payload.summary.skippedStates, ['malformed-region']);
  assert.match(payload.plans[0].remedy, /AGENTS\.md/);
  assert.equal((await readJson(join(a, 'simt-dev.json'))).projection.simtDevSha, 'aaaaaaa');
  assert.equal(await readFile(mdc, 'utf8'), mdcBefore, 'one fault must not be repaired while the rest is left alone');
});

// A field simt-dev generates must be refreshed by every writer of the manifest,
// not only by the writer that created it. `$comment` is generated, describes
// provenance, and nothing else rewrites the file — so `upgrade` carrying the
// previous copy forward left a stale and once-false description in place
// permanently. This is staleness, not leakage: it can only be caught by running
// the command against a manifest an earlier version wrote.
test('upgrade refreshes the generated comment, not only the sha', async () => {
  const root = await repo(join(await mkdtemp(join(tmpdir(), 'simt-upg-')), 'repo'), {});
  const adopt = await initCommand([root], { yes: true, acceptConflicts: true });
  assert.equal(adopt, 0);

  // Stand in for a manifest written by an earlier version: same shape, stale comment.
  const file = join(root, 'simt-dev.json');
  const manifest = JSON.parse(await readFile(file, 'utf8'));
  manifest.$comment = 'Rulings live in docs/decisions/ - each value cites its ADR.';
  await writeFile(file, JSON.stringify(manifest, null, 2) + '\n');

  assert.equal(await upgradeCommand([root], { yes: true }), 0);

  const after = JSON.parse(await readFile(file, 'utf8'));
  assert.ok(!after.$comment.includes('docs/decisions/'), after.$comment);
  assert.match(after.$comment, /simt-dev/, after.$comment);
  // The repo's own choices survive the refresh.
  assert.equal(after.id, manifest.id);
});
