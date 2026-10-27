// The CI gate, as bytes a repo owns.
//
// Two things are being tested here, and the second is the one that is easy to skip.
//
// The first is that the file works: the locator is the same one the hook shim uses,
// so the gate cannot pass locally and fail to start in CI. The hook shim has its own
// test for that; this one asserts they are the SAME function's output, because two
// copies of a three-step resolution chain diverge the first time one of them is fixed.
//
// The second is that the file is readable by the person who has to approve it. A
// workflow is the first thing simt-dev ships that a human has to argue with in a
// review rather than merely receive. It says what it runs, it says the gate fails
// rather than passes when the tool is missing, and it does not tell the reader to go
// edit something in a repository they do not have.

import assert from 'node:assert/strict';
import { cmd } from './fixture.mjs';
import test, { after } from 'node:test';
import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

import {
  renderWorkflow,
  planWorkflow,
  isOwnRepo,
  nodeFloor,
  ACTIONS,
  WORKFLOW_FILE,
  WORKFLOWS_DIR,
} from '../src/ci/workflow.mjs';
import { renderDependabot, planDependabot, DEPENDABOT_FILE } from '../src/ci/dependabot.mjs';
import { fingerprint } from '../src/resolve/fingerprint.mjs';
import { renderShim, EVENTS } from '../src/hooks/shim.mjs';
import { BIN_ENV, CLI, PACKAGE_NAME } from '../src/name.mjs';
import { renderLocator } from '../src/locate.mjs';
import { PACKAGE_ROOT } from '../src/workspace.mjs';
import { EXIT } from '../src/output/index.mjs';
import { assertClean } from './leaks.mjs';

const exec = promisify(execFile);
const BIN = new URL('../bin/simt.mjs', import.meta.url).pathname;
const temps = [];

/**
 * Run the binary and report the outcome, exit code included.
 *
 * `promisify(execFile)` rejects on a non-zero exit, which is the right default for a
 * helper that is asserting a command succeeded — and the wrong one for every test
 * about a command that must fail. Without this, a test for a refusal can only read
 * stdout if it catches the rejection, and the code it was supposed to check is the
 * code in the error.
 */
async function run(args, opts = {}) {
  try {
    const { stdout, stderr } = await exec('node', [BIN, ...args], {
      ...opts,
      env: { ...process.env, NO_COLOR: '1', ...opts.env },
    });
    return { code: 0, stdout, stderr };
  } catch (error) {
    return { code: error.code ?? 1, stdout: error.stdout ?? '', stderr: error.stderr ?? '' };
  }
}

after(async () => {
  for (const t of temps) await exec('rm', ['-rf', t]);
});

/**
 * A repo that already runs GitHub Actions.
 *
 * One existing workflow file, because the directory is the only signal that this repo
 * is a CI repo, and a signal nobody can produce by accident is not one to trust.
 */
async function actionsRepo(files = {}) {
  const root = await mkdtemp(join(tmpdir(), 'simt-ci-'));
  temps.push(root);
  await exec('git', ['init', '-q', '.'], { cwd: root });
  await writeFile(join(root, 'package.json'), JSON.stringify({ name: 'fx', private: true }, null, 2));
  await mkdir(join(root, WORKFLOWS_DIR), { recursive: true });
  await writeFile(join(root, WORKFLOWS_DIR, 'build.yml'), 'name: build\n');
  for (const [name, body] of Object.entries(files)) {
    await mkdir(join(root, name, '..'), { recursive: true });
    await writeFile(join(root, name), body);
  }
  return root;
}

/** A repo with no `.github` at all. */
async function plainRepo() {
  const root = await mkdtemp(join(tmpdir(), 'simt-ci-'));
  temps.push(root);
  await exec('git', ['init', '-q', '.'], { cwd: root });
  await writeFile(join(root, 'package.json'), JSON.stringify({ name: 'fx', private: true }, null, 2));
  return root;
}

// ---------------------------------------------------------------- the bytes

test('the workflow runs the gate, located by the same function the hook uses', () => {
  const yaml = renderWorkflow();
  assert.match(yaml, /check --root "\$ROOT"/);

  // One copy of the chain, in src/locate.mjs, and both surfaces get it from there. The
  // claim is not that the two files contain identical text - they cannot - it is that
  // neither of them spells out a resolution of its own. Two copies diverge the first
  // time one is fixed, and the symptom is a gate that passes on a laptop and cannot
  // start in CI.
  //
  // So: render the locator twice, once per surface with its own arguments, and require
  // the two renderings to be line-for-line equal apart from the three arguments that
  // are supposed to differ. The command (a hook runs gates, CI runs the check), the
  // subject (the hook's refusal is about the dispatcher, CI's about the tool), and the
  // remedy (the hook can be opted out of via `core.hooksPath`; CI cannot). Everything
  // else - the ordering, the unbound-variable guards, the three ways it refuses - is
  // the chain, and a difference in any of it is a divergence.
  const check = renderLocator('check --root "$ROOT"');
  const hook = renderLocator(`hooks run ${EVENTS[0]} --root "$ROOT"`, {
    subject: 'the dispatcher',
    remedy: 'REMEDY set SIMT_DEV_BIN to the simt-dev binary, or unset core.hooksPath to opt out',
  });
  const normalise = (text) =>
    text
      .replace(/hooks run \S+ --root "\$ROOT"/g, '<CMD>')
      .replace(/check --root "\$ROOT"/g, '<CMD>')
      .replace(/cannot locate [^.]+\./g, 'cannot locate <SUBJECT>.')
      .replace(/^.*REMEDY.*$/gm, '<REMEDY>')
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l !== '' && !l.startsWith('#'));

  const mine = normalise(check);
  const theirs = normalise(hook);
  assert.ok(mine.length > 5, `expected a resolution chain, found ${mine.length} lines`);
  assert.deepEqual(theirs, mine, 'the CI locator and the hook locator have diverged');
  // The workflow re-indents the chain to sit inside a YAML block scalar, so compare
  // line by line rather than as one string. The remedy echo is the one line skipped:
  // it is an argument to `renderLocator`, not part of the chain, and the two surfaces
  // genuinely say different things there. What it has to agree on is named below.
  const carries = (text, lines, where) => {
    for (const line of lines.split('\n')) {
      if (line.trim() === '' || /REMEDY/.test(line)) continue;
      assert.ok(text.includes(line.trim()), `${where} does not carry this line of the shared locator:\n${line}`);
    }
  };
  carries(yaml, check, 'the workflow');
  carries(renderShim(EVENTS[0]), hook, 'the hook shim');
  // The package is published, so the remedy names the install that finds it. Which
  // install depends on the repo's kind: a devDependency where package.json exists (the
  // default here), the release binary into the repository where there is no
  // node_modules to pin in (ADR-098). The two must not be mixed, because each names
  // the one command that works for that repo. The workflow's install line is a
  // different surface and is checked below.
  assert.match(renderShim(EVENTS[0]), new RegExp(`set ${BIN_ENV} to the ${CLI} binary`));
  assert.match(renderShim(EVENTS[0]), /npm i -D simt-dev@/);
  assert.doesNotMatch(renderShim(EVENTS[0], { npm: false }), /npm i -D/);
  // The binary remedy downloads the asset for THIS machine into .simt/bin, and it must
  // not name a node install: the repo kind this remedy is for has no npm.
  const nonNpm = renderShim(EVENTS[0], { npm: false });
  assert.doesNotMatch(nonNpm, /npm i -g/);
  assert.match(nonNpm, /curl -fsSL/);
  assert.match(nonNpm, /\.simt\/bin\/simt/);
  assert.match(yaml, cmd('REMEDY run: npm i -D {cli}'));
});

test('a job that cannot find the tool fails rather than passes', () => {
  // The one outcome worse than a red build: a green tick from a check that never ran.
  // Every locator chain ends in a refusal with a non-zero exit, and the file says so,
  // because the next person to read this file is the one who has to believe it.
  const yaml = renderWorkflow();
  assert.match(yaml, cmd('cannot locate {cli}'));
  assert.match(yaml, /FAILS instead of passing/);
});

test('a repository without npm installs the release binary in CI and still runs the gate', () => {
  // S35, as ruled by ADR-098: a Gradle or Connect IQ repo has no node_modules to pin
  // simt-dev in, so CI downloads the release binary into the repository - verified
  // against the checksum published beside it - and the machine remedy names the same
  // bytes. The two must agree, or the gate passes in one place and cannot start in
  // the other. The binary needs no node, so the job must not install one: setup-node
  // would be the toolchain this channel exists to remove, present in the one place it
  // was not.
  const yaml = renderWorkflow({ own: false, npm: false });
  assert.doesNotMatch(yaml, /npm i -g/);
  assert.doesNotMatch(yaml, /setup-node/);
  assert.doesNotMatch(yaml, /npm ci/);
  // The platform comes from the machine (uname), never from a runner expression:
  // GitHub substitutes `${{ runner.os }}` into the script, where `$( … )` is a
  // command substitution that tries to EXECUTE "Linux" and `set -eu` refuses.
  // test/binary.test.mjs runs the rendered step, so this cannot come back quietly.
  assert.doesNotMatch(yaml, /\$\{\{\s*runner\./, 'the install step must derive its platform in the shell');
  // The download, its checksum verification, and the install into .simt/bin.
  assert.match(yaml, /simt-dev-[\d.]+-\$os-\$arch/);
  assert.match(yaml, /\.sha256/);
  assert.match(yaml, /openssl sha256/);
  assert.match(yaml, /\.simt\/bin\/simt/);
  // The locator finds the binary before PATH, and the remedy downloads it.
  assert.match(yaml, new RegExp(`${CLI} check|check --root`));
  assert.match(yaml, /REMEDY run: .*curl -fsSL/);
  assert.match(yaml, /releases\/download\/v[\d.]+/);
});

test('the workflow is gated on pull requests and does not rewrite itself', () => {
  const yaml = renderWorkflow();
  assert.match(yaml, /^on:\n {2}pull_request:$/m);
  assert.match(yaml, /never rewrites it/);
  assert.match(yaml, /^permissions:\n {2}contents: read$/m);
});

test('the workflow is shell a POSIX sh will accept, running the gate it says it runs', async () => {
  // A YAML syntax error is found on the adopting repo's first pull request, in public,
  // and a sh syntax error inside `run: |` is found at the same moment. `sh -n` on the
  // script body catches the second; the first is caught by asserting the block
  // scalar's content is indented past its key, which is what YAML actually requires.
  const yaml = renderWorkflow();
  const lines = yaml.split('\n');
  const runKey = lines.findIndex((l) => /^ {8}run: \|$/.test(l));
  assert.ok(runKey > 0, 'the check step must use a block scalar');
  const body = [];
  for (const line of lines.slice(runKey + 1)) {
    if (line.trim() === '') { body.push(''); continue; }
    const indent = line.length - line.trimStart().length;
    if (indent < 10) break;
    body.push(line.slice(10));
  }
  assert.match(body.join('\n'), new RegExp(`${CLI} check|check --root`));

  const script = join(await mkdtemp(join(tmpdir(), 'simt-ci-sh-')), 'step.sh');
  temps.push(join(script, '..'));
  await writeFile(script, body.join('\n'));
  await exec('sh', ['-n', script]);
});

test('the workflow ships nothing only its author can act on', () => {
  assertClean(WORKFLOW_FILE, renderWorkflow());
});

test('the workflow names a command this package actually installs', () => {
  // `simt sync` did not exist and 102 remedy strings said to run it. The command here
  // is the tool's own, and the package name is the one in package.json.
  assert.match(renderWorkflow(), new RegExp(`npm i -D ${PACKAGE_NAME.replace('/', '\\/')}`));
  // The command moved and the project name did not, so the old guard - 'the bare word
  // simt must not appear' - no longer means anything: it would forbid the command itself.
  // What is worth forbidding is the OLD spelling surviving in the rendered gate.
  assert.doesNotMatch(renderWorkflow(), /\bsimt-dev (?:check|sync|hooks|ci)\b/, 'the rendered gate still names the old command');
});

// ---------------------------------------------------------------- when it applies

test('a repo that runs Actions and has no gate is offered one', async () => {
  const plan = await planWorkflow(await actionsRepo());
  assert.equal(plan.action, 'create');
  assert.equal(plan.file, WORKFLOW_FILE);
  assert.equal(plan.reason, null);
});

test('a repo with no .github is left alone, and told why', async () => {
  // Creating that directory starts running jobs on pull requests the team did not ask
  // for. A skip with a stated reason is a decision they can reverse; a silent
  // directory is one they discover from a failing build.
  const plan = await planWorkflow(await plainRepo());
  assert.equal(plan.action, 'skip');
  assert.match(plan.reason, /no \.github\/workflows directory/);
});

test('a file that is already there is never counted as needing a write', async () => {
  const root = await actionsRepo({ [WORKFLOW_FILE]: 'name: ours\n' });
  const plan = await planWorkflow(root);
  assert.equal(plan.action, 'unchanged');
  // Read-only on purpose. Rewriting a repo's CI would delete jobs this tool cannot see,
  // and a gate that inspects a file it also owns would report its own drift forever.
  assert.equal(plan.bytes, Buffer.byteLength('name: ours\n'));
});

// ---------------------------------------------------------------- end to end

test('init writes the workflow into a repo that runs Actions, and says so', async () => {
  const root = await actionsRepo();
  // Both streams, because they answer different questions. The plan goes to stdout:
  // it is the thing the reader approves. `wrote` goes to stderr: it is advice about
  // what just happened to their disk, and a caller piping stdout to a file should not
  // find it there.
  const { stdout, stderr } = await exec('node', [BIN, 'init', '--yes', '--surfaces', 'cursor'], {
    cwd: root,
    env: { ...process.env, NO_COLOR: '1' },
  });

  const written = await readFile(join(root, WORKFLOW_FILE), 'utf8');
  assert.equal(written, renderWorkflow());
  // Every file init creates is named in the plan it printed, so it is a file the reader
  // approved rather than one they find in the diff afterwards.
  assert.match(stdout, new RegExp(`create\\s+${WORKFLOW_FILE.replace(/\//g, '\\/')}`));
  assert.match(stderr, new RegExp(`wrote\\s+${WORKFLOW_FILE.replace(/\//g, '\\/')}`));
});

test('init writes the release-binary install into a Gradle repo with no package.json', async () => {
  // S35, as ruled by ADR-098: the fixture is a real Gradle repository — no package.json,
  // so there is no node_modules to pin simt-dev in. init must detect that and write the
  // workflow whose CI downloads the release binary the machine remedy names, not a node
  // install that would fail in this repo. The gate still runs from it.
  const root = await mkdtemp(join(tmpdir(), 'simt-ci-'));
  temps.push(root);
  await exec('git', ['init', '-q', '.'], { cwd: root });
  await mkdir(join(root, WORKFLOWS_DIR), { recursive: true });
  await writeFile(join(root, WORKFLOWS_DIR, 'build.yml'), 'name: build\n');
  await writeFile(join(root, 'build.gradle'), 'plugins {}\n');

  const { stdout } = await exec('node', [BIN, 'init', '--yes', '--surfaces', 'cursor'], {
    cwd: root,
    env: { ...process.env, NO_COLOR: '1' },
  });

  const written = await readFile(join(root, WORKFLOW_FILE), 'utf8');
  assert.equal(written, renderWorkflow({ own: false, npm: false }));
  assert.doesNotMatch(written, /npm i -g/);
  assert.match(written, /\.simt\/bin\/simt/);
  assert.match(stdout, new RegExp(`create\\s+${WORKFLOW_FILE.replace(/\//g, '\\/')}`));
});

test('init is dry-run by default, and then it still writes nothing', async () => {
  const root = await actionsRepo();
  const { stdout } = await exec('node', [BIN, 'init'], { cwd: root, env: { ...process.env, NO_COLOR: '1' } });
  assert.match(stdout, /create\s+\.github\/workflows\/simt-dev-check\.yml/);
  await assert.rejects(readFile(join(root, WORKFLOW_FILE), 'utf8'));
});

test('init leaves a repo with no .github exactly as it found it', async () => {
  const root = await plainRepo();
  const { stdout } = await exec('node', [BIN, 'init', '--yes'], {
    cwd: root,
    env: { ...process.env, NO_COLOR: '1' },
  });
  await assert.rejects(readFile(join(root, WORKFLOW_FILE), 'utf8'), 'the workflow was written to a repo with no CI');
  await assert.rejects(readFile(join(root, '.github', 'workflows'), 'utf8'));
  // The skip states its reason and the way out, so "not offered" is distinguishable
  // from "this repo does not use GitHub Actions".
  assert.match(stdout, /skip\s+\.github\/workflows\/simt-dev-check\.yml\s+no \.github\/workflows directory/);
  assert.match(stdout, /create \.github\/workflows\/ first/);
});

test('check gates the merge: an Actions repo with no workflow fails, a repo with one passes', async () => {
  const ungated = await actionsRepo();
  const first = await exec('node', [BIN, 'check'], { cwd: ungated, env: { ...process.env, NO_COLOR: '1' } }).catch(
    (e) => e,
  );
  assert.notEqual(first.code, 0, 'a repo that merges ungated passed the gate');
  assert.match(first.stdout, /ABSENT\s+\.github\/workflows\/simt-dev-check\.yml/);
  // A finding whose fix the reader has to guess at is a finding that gets skipped.
  assert.match(first.stdout, cmd('remedy: {cli} init --yes'));

  await exec('node', [BIN, 'init', '--yes', '--surfaces', 'cursor'], { cwd: ungated, env: { ...process.env, NO_COLOR: '1' } });
  const gated = await exec('node', [BIN, 'check'], { cwd: ungated, env: { ...process.env, NO_COLOR: '1' } });
  assert.doesNotMatch(gated.stdout, /simt-dev-check\.yml/);
});

test('the gate never inspects the contents of a workflow it did not write', async () => {
  // A repo that adds its own deployment job, or reorders the steps, is not drifting.
  // Reporting that would make `check` permanently red with no fix except re-running
  // init, which is the failure mode a gate nobody trusts ends up in.
  const root = await actionsRepo({ [WORKFLOW_FILE]: 'name: ours\non: push\n' });
  const found = await exec('node', [BIN, 'check'], { cwd: root, env: { ...process.env, NO_COLOR: '1' } }).catch(
    (e) => e,
  );
  // The repo is red here for its missing AGENTS.md, which this file has nothing to do
  // with. Only the workflow's absence from the output is the claim under test.
  assert.doesNotMatch(found.stdout, /simt-dev-check\.yml/);
  assert.equal((await planWorkflow(root)).action, 'unchanged');
});

test('a repo with no .github is not told to have a workflow', async () => {
  const root = await plainRepo();
  const { stdout } = await exec('node', [BIN, 'check'], { cwd: root, env: { ...process.env, NO_COLOR: '1' } }).catch(
    (e) => e,
  );
  assert.doesNotMatch(stdout, /simt-dev-check\.yml/);
});

// ------------------------------------------------------- the one exception

test('a repository that adopted simt-dev is not mistaken for simt-dev', async () => {
  // The whole exception is one comparison, and the failure it must not have is the
  // catastrophic one: an adopting repo recognised as the template's own repo, whose
  // CI this tool then rewrites. A fresh temp repo has to be "not ours", and so does a
  // path inside this repository's parent - which is a different repository.
  assert.equal(isOwnRepo(PACKAGE_ROOT), true);
  assert.equal(isOwnRepo(await plainRepo()), false);
  assert.equal(isOwnRepo(await actionsRepo()), false);
  assert.equal(isOwnRepo(join(PACKAGE_ROOT, '..')), false);
  assert.equal(isOwnRepo(`${PACKAGE_ROOT}/rules`), false);
});

test('simt-dev\'s own repository refreshes its copy; every other one never does', async () => {
  const stale = renderWorkflow().replace('node-version', 'node-version-was');
  assert.notEqual(stale, renderWorkflow(), 'the fixture must actually differ');

  // The template's own repo: a copy that no longer matches is drift, and it is
  // reported as such rather than left for the next person to notice in a diff.
  const own = await planWorkflow(PACKAGE_ROOT);
  assert.equal(own.own, true);

  // Everyone else: same bytes, same verdict - `unchanged`. This is the ruling the
  // exception narrows, and the assertion that it still holds for every adopting repo
  // is the reason the exception is allowed to exist at all.
  const consumer = await actionsRepo({ [WORKFLOW_FILE]: stale });
  const plan = await planWorkflow(consumer);
  assert.equal(plan.own, false);
  assert.equal(plan.action, 'unchanged');
  assert.equal(plan.reason, null);
});

test('simt-dev\'s own copy is current on disk, and check says so', async () => {
  // The guard that makes the refresh real: this file is committed, and the whole point
  // of the exception is that a template change must not land with a copy still
  // describing the old gate. Nothing else in the tool can catch that - a consumer's
  // workflow is deliberately never compared - so this is the one place it is checked.
  const onDisk = await readFile(join(PACKAGE_ROOT, WORKFLOW_FILE), 'utf8');
  assert.equal(
    onDisk,
    renderWorkflow({ own: true }),
    `the committed copy in simt-dev\'s own repo is not what the renderer produces; run: ${CLI} ci --yes`,
  );
  const plan = await planWorkflow(PACKAGE_ROOT);
  assert.equal(plan.action, 'unchanged');
  assert.equal(plan.reason, null);

  // And `check`, run from a scratch cwd with this repo as the target, must not report
  // it. A drift finding here would be the one finding nothing could fix.
  const found = await exec('node', [BIN, 'check', '--root', PACKAGE_ROOT], {
    cwd: PACKAGE_ROOT,
    env: { ...process.env, NO_COLOR: '1' },
  }).catch((e) => e);
  assert.doesNotMatch(found.stdout, /simt-dev-check\.yml/);
});

test('the own copy explains the exception in its own bytes', async () => {
  // A reader of this file in this repository has to be able to tell what a diff means
  // without opening a decision record. That is the whole reason the header exists, so
  // the claims it makes are asserted rather than assumed.
  const own = renderWorkflow({ own: true });
  assert.match(own, /refreshed by it/);
  assert.match(own, /a diff\n# here means the GATE changed/);
  assert.match(own, cmd('{cli} ci --yes'));
  // ...and must not claim the adopting repo's promise, which does not hold here.
  assert.doesNotMatch(own, /never rewrites it/);

  const theirs = renderWorkflow();
  assert.match(theirs, /never rewrites it/);
  assert.doesNotMatch(theirs, /refreshed by it/);
});

test('the node floor is the same number in engines and both templates (S47)', async () => {
  const pkg = JSON.parse(await readFile(join(PACKAGE_ROOT, 'package.json'), 'utf8'));
  assert.equal(pkg.engines.node, '>=22.20.0');
  assert.equal(nodeFloor(), '22.20.0');
  const consumer = renderWorkflow();
  const own = renderWorkflow({ own: true });
  assert.match(consumer, /node-version: '22\.20\.0'/);
  assert.match(own, /node: \['22\.20\.0', '24', '26'\]/);
  assert.match(own, /node-version: '\$\{\{ matrix\.node \}\}'/);
  assert.match(await readFile(join(PACKAGE_ROOT, 'README.md'), 'utf8'), /Node >= 22\.20\.0/);
});

test('every action is pinned to the commit that runs it, with the release beside it (S48)', () => {
  // A tag is a name that moves: `actions/checkout@v4` is whatever that project
  // published under the name today, so the bytes executing a gate are not the bytes
  // the adopting repository reviewed. Both templates, because the adopting copy is the
  // one nobody in this repository can see after `init`.
  for (const [label, yaml] of [['own', renderWorkflow({ own: true })], ['adopting', renderWorkflow()]]) {
    const uses = [...yaml.matchAll(/uses: (\S+)/g)].map((m) => m[1]);
    assert.ok(uses.length > 0, `${label}: no actions to check`);
    for (const ref of uses) {
      assert.match(ref, /^[\w.-]+\/[\w.-]+@[0-9a-f]{40}$/, `${label}: ${ref} is not a commit SHA`);
    }
    // The comment is what makes a pinned SHA reviewable - a reader cannot tell what
    // `11d5960a` is, and an unpinned-looking line invites somebody to "fix" it back.
    for (const line of yaml.split('\n').filter((l) => /uses: /.test(l))) {
      assert.match(line, /@[0-9a-f]{40} # v\d+\.\d+\.\d+$/, `${label}: a pin with no release comment: ${line}`);
    }
  }
});

test('the pin and its release name the same commit Dependabot would', () => {
  // The pairs are stated in the source table, so a reader can check them without a
  // network call. A SHA and a release that disagree is the failure the comment
  // invites: the line reads as pinned to v4.4.0 and is not.
  assert.deepEqual(ACTIONS, {
    checkout: { repo: 'actions/checkout', commit: '3d3c42e5aac5ba805825da76410c181273ba90b1', release: 'v7.0.1' },
    setupNode: { repo: 'actions/setup-node', commit: '49933ea5288caeca8642d1e84afbd3f7d6820020', release: 'v4.4.0' },
  });
  // 40 hex characters is what makes it a commit id at all; the tag form this replaced
  // was a mutable name of the same length, which is the whole difference.
  for (const { commit } of Object.values(ACTIONS)) {
    assert.match(commit, /^[0-9a-f]{40}$/);
  }
});

test('the own gate runs on both platforms ADR-012 claims (S48)', () => {
  // ADR-012 ruled that CI verifies on `macos-latest` and `ubuntu-latest`, and until
  // this matrix landed that sentence was false in the one repository that could make
  // it true. Nothing read it: `package.json` declares `os` for npm to enforce, and no
  // check here ever ran a test on a second platform.
  const own = renderWorkflow({ own: true });
  assert.match(own, /os: \['ubuntu-latest', 'macos-latest'\]/);
  // `runs-on` is derived from the matrix rather than written twice, so a job cannot
  // expand to six combinations that all run on one of them.
  assert.match(own, /^ {4}runs-on: \$\{\{ matrix\.os \}\}$/m);
  assert.doesNotMatch(own, /^ {4}runs-on: ubuntu-latest$/m);
  // Windows stays out: ADR-012 dropped it, and "add the third runner" is the request
  // that comes next if nobody writes down why there are two.
  assert.doesNotMatch(own, /windows/);
  // And a job that names a matrix has to say which axis it is on, or six runs render
  // as six identical rows in the checks list.
  assert.match(own, /^ {4}name: \$\{\{ matrix\.os \}\} node \$\{\{ matrix\.node \}\}$/m);
});

test('the adopting gate stays on one platform and the floor (S48)', () => {
  // The macOS claim is about this repository's own gate. An adopting repository's
  // runner is its own decision, and doubling a stranger's CI bill to satisfy a record
  // written here would be this tool deciding for them.
  const yaml = renderWorkflow();
  assert.match(yaml, /^ {4}runs-on: ubuntu-latest$/m);
  assert.doesNotMatch(yaml, /matrix:/);
  assert.match(yaml, new RegExp(`^ {4}name: ${CLI} check$`, 'm'));
});

test('the own copy runs a gate this repository can actually pass', async () => {
  // `simt check` is red here by design: this AGENTS.md is hand-written and never
  // self-adopted, so the check reports it as unmanaged on every run. A CI job that is
  // red the day it lands is worse than no job, because it teaches the reader to ignore
  // the thing they added in order to stop ignoring things.
  const own = renderWorkflow({ own: true });
  assert.doesNotMatch(own, /run: \|/);
  assert.match(own, /run: npm test/);
  assert.match(own, /run: node bin\/simt\.mjs graph lint/);
  // Every command it names has to exist in this repository, and that is checkable:
  // the two are the same checks `.githooks/pre-push` already runs before a push.
  const hook = await readFile(join(PACKAGE_ROOT, '.githooks', 'pre-push'), 'utf8');
  assert.match(hook, /npm test/);
  assert.match(hook, /graph lint/);
  for (const script of ['test', 'lint']) {
    assert.match(await readFile(join(PACKAGE_ROOT, 'package.json'), 'utf8'), new RegExp(`"${script}":`));
  }
});

test('the test script names its files, because the floor cannot run the obvious spelling', async () => {
  // `node --test test/` is the obvious spelling and it is wrong on two of the three node
  // versions this repository's own gate runs. 22 and 24 resolve the argument as a module
  // path and fail with `Cannot find module '.../test'`; only 26 walks the directory. The
  // suite was therefore green on the author's machine and red on four of the six matrix
  // legs, and nothing inside the package could tell - so the SHAPE of the script is
  // asserted here rather than the version that happens to be installed.
  //
  // The second half is the one that stops the obvious repair landing. A pattern naming
  // fewer files than the directory holds drops tests without failing anything, which is
  // how a suite goes to 700 tests and nobody notices for a month.
  const pkg = JSON.parse(await readFile(join(PACKAGE_ROOT, 'package.json'), 'utf8'));
  const patterns = pkg.scripts.test.split(/\s+/).filter((arg) => !arg.startsWith('-'));
  assert.ok(patterns.length > 0, 'the test script passes nothing to --test');

  for (const pattern of patterns) {
    assert.doesNotMatch(
      pattern,
      /\/$/,
      `"${pattern}" is a directory: node --test resolves it as a module path below 26`,
    );
  }

  const files = (await readdir(join(PACKAGE_ROOT, 'test'))).filter((f) => f.endsWith('.test.mjs'));
  const matches = (pattern) =>
    new RegExp(
      `^${pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\\\*/g, '[^/]*')}$`,
    );
  const uncovered = files.filter(
    (f) => !patterns.some((p) => matches(p).test(`test/${f}`)),
  );
  assert.deepEqual(
    uncovered,
    [],
    `the test script does not run ${uncovered.join(', ')}; a narrowing pattern drops tests silently`,
  );
});

test('the own copy ships nothing a reader outside this repository cannot act on', async () => {
  // Deliberately NOT `assertClean`: the own copy names `src/ci/workflow.mjs` on
  // purpose, because it lives in the one repository where that path resolves for its
  // reader. What it must not carry is this estate's repository names, which is the
  // half of `assertClean` that applies to every copy.
  const { LEAKS, AUTHOR_ADDRESSED } = await import('./leaks.mjs');
  const own = renderWorkflow({ own: true });
  for (const { re, what } of [...LEAKS, ...AUTHOR_ADDRESSED]) {
    const m = re.exec(own);
    assert.equal(m, null, `simt-dev's own gate copy ships ${what}: ${JSON.stringify(m?.[0])}`);
  }
});

test('a stale copy in simt-dev\'s own repository is reported, with the fix named', async () => {
  // This is the only test in the suite that writes to the repository it runs in, and
  // the reason is that the behaviour has no fixture. The drift finding is reachable
  // only when `isOwnRepo` is true, and the only directory that satisfies that is the
  // package root itself - so a temp repo cannot produce this case at all. The restore
  // is in a `finally` for the same reason: a thrown assertion must not leave a tracked
  // file different from the commit it came from.
  //
  // Without this, the exception would be a claim about a code path nothing exercises:
  // the copy could stop matching the renderer and `check` would stay quiet, which is
  // the exact drift the exception exists to prevent.
  const path = join(PACKAGE_ROOT, WORKFLOW_FILE);
  const before = await readFile(path, 'utf8');
  try {
    // A token this template owns, so the edit is a drift rather than a no-op. It used
    // to be `runs-on: ubuntu-latest`, which the macOS matrix (S48) removed.
    await writeFile(path, before.replace('timeout-minutes: 5', 'timeout-minutes: 9'));
    const plan = await planWorkflow(PACKAGE_ROOT);
    assert.equal(plan.action, 'refresh');
    assert.match(plan.reason, /gate template has changed/);

    const red = await exec('node', [BIN, 'check', '--root', PACKAGE_ROOT], {
      cwd: PACKAGE_ROOT,
      env: { ...process.env, NO_COLOR: '1' },
    }).catch((e) => e);
    assert.match(red.stdout, /DRIFT\s+\.github\/workflows\/simt-dev-check\.yml/);
    assert.match(red.stdout, cmd('remedy: {cli} ci --yes'));

    // And the fix is the thing that clears it. `--yes` because `ci` writes like every
    // other writer in this tool: shown first, changed only when told.
    await exec('node', [BIN, 'ci', '--yes'], { cwd: PACKAGE_ROOT, env: { ...process.env, NO_COLOR: '1' } });
    assert.equal(await readFile(path, 'utf8'), renderWorkflow({ own: true }));
    assert.equal((await planWorkflow(PACKAGE_ROOT)).action, 'unchanged');
  } finally {
    await writeFile(path, before);
  }
});

test('the own gate\'s own copy is checked with a command that can fail', async () => {
  // The step this guards is the one whose comment says the drift would otherwise land
  // unnoticed, and it ran `ci` — which previews and exits 0. So the step printed the
  // drift it exists to catch and passed. A check that cannot fail is not a check, and
  // this is the only place in the tool where that shape is load-bearing.
  const yaml = renderWorkflow({ own: true });
  assert.match(
    yaml,
    /run: node bin\/simt\.mjs ci --check/,
    'the own gate must run the form that can fail, or the step is decoration',
  );
  // And not both spellings: a bare `ci` left in the file would be the same step
  // described twice, one of which still passes on drift.
  assert.doesNotMatch(yaml, /run: node bin\/simt\.mjs ci$/m);
});

test('`ci --check` exits non-zero on a stale copy and shows what changed', async () => {
  // Same constraint as the test above: the case is only reachable when `isOwnRepo` is
  // true, and the only directory that satisfies that is the package root. Same `finally`,
  // same reason — a thrown assertion must not leave a tracked file changed.
  const path = join(PACKAGE_ROOT, WORKFLOW_FILE);
  const before = await readFile(path, 'utf8');
  try {
    // A current copy first: `--check` on a clean tree must be silent, or the step would
    // fail every push and be turned off, which is how a real gate gets deleted.
    const clean = await run(['ci', '--check'], { cwd: PACKAGE_ROOT });
    assert.equal(clean.code, 0, clean.stdout + clean.stderr);
    assert.match(clean.stdout, /current\s+\.github\/workflows/);

    await writeFile(path, `${before}\n# a hand edit that drifts the copy\n`);
    const stale = await run(['ci', '--check'], { cwd: PACKAGE_ROOT });
    assert.equal(stale.code, EXIT.FAIL, 'a stale copy must fail the step that exists to catch it');
    assert.match(stale.stdout, /a hand edit that drifts the copy/);
    // The diff is the reason `--check` is worth more than an exit code: the reader is
    // the author of the template change, and the question is what they changed.
    assert.match(stale.stdout, /^--- a\/\.github\/workflows\/simt-dev-check\.yml$/m);
    assert.match(stale.stdout, /^\+\+\+ b\/\.github\/workflows\/simt-dev-check\.yml$/m);
    assert.match(stale.stdout, /^-\# a hand edit that drifts the copy$/m);
    assert.match(stale.stdout, cmd('apply with: {cli} ci --yes'));

    // And `--json --check` says the same thing, so a caller is not left reading prose.
    const asJson = await run(['ci', '--check', '--json'], { cwd: PACKAGE_ROOT });
    assert.equal(asJson.code, EXIT.FAIL);
    const doc = JSON.parse(asJson.stdout);
    assert.equal(doc.ok, false, 'ok must agree with the exit code (ADR-035)');
    assert.match(doc.remedy, cmd('{cli} ci --yes'));
    // The plan carries both sides of the comparison so the verdict and the diff cannot
    // disagree; a JSON payload is not the place for two copies of a workflow file.
    assert.equal(doc.files.some((f) => 'source' in f || 'text' in f), false);

    // `--check` never writes, whatever else it is given. A check that repairs is a
    // second writer, and ADR-036 is why a command does not get to be one by accident.
    const stillStale = await readFile(path, 'utf8');
    assert.match(stillStale, /a hand edit that drifts the copy/);
  } finally {
    await writeFile(path, before);
  }
});

test('`ci --json` emits exactly one document in every mode, including --dry-run', async () => {
  // `--json --dry-run` used to print nothing: the JSON branch was guarded by
  // `yes !== true && dryRun !== true`, so the one combination a script reaches for was
  // the one combination with no document. ADR-035 requires one document under `--json`.
  //
  // Run in this repository, on a stale copy, and not in a fixture. A temp repo cannot
  // reach this code: `isOwnRepo` is false there, so every mode takes the refusal path
  // and prints a perfectly good document — which is how a test about the plan printed
  // a document for the wrong reason and passed with the guard restored.
  const path = join(PACKAGE_ROOT, WORKFLOW_FILE);
  const before = await readFile(path, 'utf8');
  try {
    await writeFile(path, `${before}\n# a hand edit that drifts the copy\n`);
    for (const args of [
      ['ci', '--json'],
      ['ci', '--json', '--dry-run'],
      ['ci', '--json', '--check'],
      ['ci', '--json', '--yes', '--dry-run'],
    ]) {
      const got = await run(args, { cwd: PACKAGE_ROOT });
      const label = args.join(' ');
      assert.ok(got.stdout.trimStart().startsWith('{'), `${label} printed no document. Got: ${got.stdout.slice(0, 120)}`);
      let doc;
      assert.doesNotThrow(() => (doc = JSON.parse(got.stdout)), `${label} printed an unparseable document`);
      assert.equal(doc.written, false, `${label} must not write`);
      // `ok` agrees with the exit code, or one of the two is a lie (ADR-035).
      assert.equal(doc.ok, got.code === 0, `${label}: ok and the exit code disagree`);
    }
  } finally {
    await writeFile(path, before);
  }
});

test('ci writes the own copy, is dry-run by default, and says when it is current', async () => {
  const { stdout } = await exec('node', [BIN, 'ci'], {
    cwd: PACKAGE_ROOT,
    env: { ...process.env, NO_COLOR: '1' },
  });
  assert.match(stdout, /current\s+\.github\/workflows\/simt-dev-check\.yml/);

  // The plan is shown before anything changes, and nothing changes without --yes. The
  // file it would write is the same file, so this asserts the shape of the promise
  // rather than re-doing a write that would dirty the tree.
  const json = JSON.parse(
    (await exec('node', [BIN, 'ci', '--json'], { cwd: PACKAGE_ROOT, env: { ...process.env, NO_COLOR: '1' } })).stdout,
  );
  assert.equal(json.ok, true);
  assert.equal(json.action, 'unchanged');
  assert.equal(json.written, false);
});

test('ci refuses a repository that adopted simt-dev, and names the command that owns it', async () => {
  // A reader who runs this in an adopting repo has almost certainly been told to run
  // it by a remedy somewhere. The useful answer is which command does exist there.
  //
  // It is also an error, which this test used to say it was not. A refusal reported
  // as `ok: true` and exit 0 is a document asserting that the request succeeded while
  // the text beside it says it was refused — and a caller reading `ok` had no way to
  // know which one the writer meant. `EXIT.UNSUPPORTED` is the code for "cannot be
  // satisfied in this repository", which is exactly the situation, and it is the same
  // code ADR-035 requires `ok` to agree with.
  const root = await actionsRepo();
  const refused = await run(['ci', '--yes'], { cwd: root });
  assert.equal(refused.code, EXIT.UNSUPPORTED, refused.stderr);
  assert.match(refused.stdout, /owner\s+this repository, not simt-dev/);
  assert.match(refused.stderr, new RegExp(`remedy: \\s+${CLI} init --yes`));
  // Above all: it wrote nothing, in a repo that had no gate file at all.
  await assert.rejects(readFile(join(root, WORKFLOW_FILE), 'utf8'));

  // And the JSON document says the same thing as the exit code, which is the half of
  // the invariant that a text assertion cannot reach.
  const asJson = await run(['ci', '--json'], { cwd: root });
  assert.equal(asJson.code, EXIT.UNSUPPORTED);
  const doc = JSON.parse(asJson.stdout);
  assert.equal(doc.ok, false, 'a refusal reported as ok:true is a lie a caller cannot detect');
  assert.equal(doc.own, false);
  assert.match(doc.error, /belongs to this repository/);
  assert.match(doc.remedy, cmd('{cli} init --yes'));
});

// ------------------------------------------------- the dependency-updates config
//
// Dependabot is a second `.github` file and not a third baseline, and the difference
// is structural rather than editorial: `updates:` is a YAML list, two lists cannot be
// concatenated, and so there is no region shape that could mean "these entries are
// mine and those are yours". ADR-025's region mechanism has nothing to merge here.
// Everything below is about that file being correct on its own terms.

test('every ecosystem in the config is one GitHub documents', async () => {
  // Names taken from the Dependabot options reference, not from memory. A config that
  // names an ecosystem Dependabot does not implement is rejected by GitHub with no
  // useful message, and the repo's dependency updates stop silently.
  const KNOWN = new Set([
    'github-actions', 'npm', 'pip', 'gomod', 'cargo', 'bundler', 'composer',
    'maven', 'docker', 'docker-compose', 'terraform', 'gradle', 'mix', 'nuget',
    'rust-toolchain', 'devcontainers', 'helm', 'elm', 'gitsubmodule', 'pub', 'swift', 'uv', 'bun',
  ]);
  const yaml = renderDependabot(
    ['has-pyproject', 'has-requirements', 'has-go-mod', 'has-cargo-toml', 'has-gemfile',
      'has-composer', 'has-maven-pom', 'has-dockerfile', 'has-compose', 'has-terraform'],
    { stack: ['node', 'typescript'] },
  );
  const values = [...yaml.matchAll(/package-ecosystem: "([^"]+)"/g)].map((m) => m[1]);
  for (const v of values) assert.ok(KNOWN.has(v), `${v} is not a documented package-ecosystem`);
  assert.match(yaml, /^version: 2$/m);
});

test('detection decides the entries, and a manifest nobody has is never listed', async () => {
  // The failure this prevents is an entry that looks configured and configures
  // nothing: Dependabot finds no manifest, opens no pull request, and the config
  // reads as though the repo's dependencies are watched.
  const none = renderDependabot([], { stack: [] });
  assert.match(none, /package-ecosystem: "github-actions"/);
  assert.doesNotMatch(none, /package-ecosystem: "npm"/);
  assert.doesNotMatch(none, /package-ecosystem: "pip"/);

  // A python repo with no package.json is not an npm repo.
  const py = renderDependabot(['has-pyproject'], { stack: [] });
  assert.match(py, /package-ecosystem: "pip"/);
  assert.doesNotMatch(py, /package-ecosystem: "npm"/);

  // And a repo that does have one is.
  const node = renderDependabot(['has-lockfile'], { stack: ['node'] });
  assert.match(node, /package-ecosystem: "npm"/);
});

test('two manifests for one ecosystem produce one entry, not two', async () => {
  // pyproject.toml and requirements.txt are two ways of declaring python deps and
  // Dependabot reads both under `pip`. Two `pip` entries is a duplicate the config
  // rejects or collapses, and the reader cannot tell which one won.
  const yaml = renderDependabot(['has-pyproject', 'has-requirements'], { stack: [] });
  const pips = [...yaml.matchAll(/package-ecosystem: "pip"/g)];
  assert.equal(pips.length, 1);
});

test('a Gradle repo with a submodule watches gradle and gitsubmodule', async () => {
  const root = await mkdtemp(join(tmpdir(), 'simt-dep-'));
  temps.push(root);
  await writeFile(join(root, 'build.gradle'), 'plugins {}\n');
  await writeFile(join(root, '.gitmodules'), '[submodule "app-ui"]\n\tpath = app-ui\n');
  const found = await fingerprint(root);
  const yaml = renderDependabot(found.facts, { stack: found.stack });
  assert.match(yaml, /package-ecosystem: "gradle"/);
  assert.match(yaml, /package-ecosystem: "gitsubmodule"/);
});

test('a Makefile is not a dependency manifest and is not mapped to an ecosystem', async () => {
  // `has-build-system` covers Makefile, CMakeLists and meson.build. Dependabot has no
  // ecosystem that reads them, and mapping the fact to `maven` would produce a config
  // claiming to watch a build tool's "dependencies" - the detection-driven ruling
  // exists precisely to stop a plausible-looking line that watches nothing.
  const yaml = renderDependabot(['has-build-system'], { stack: [] });
  assert.doesNotMatch(yaml, /package-ecosystem: "maven"/);
  assert.match(yaml, /package-ecosystem: "github-actions"/);
});

test('entry order is the table order, not detection order', async () => {
  // Determinism is a feature: a pull request that adds a manifest must show one added
  // entry, not a reshuffle. Facts arrive from sets and file listings, so without a
  // fixed order the same repo renders differently across runs.
  const facts = ['has-terraform', 'has-pyproject', 'has-dockerfile'];
  assert.equal(renderDependabot(facts, { stack: [] }), renderDependabot(facts.slice().reverse(), { stack: [] }));
});

test('the dependabot bytes ship nothing a reader outside this repository cannot act on', () => {
  // The leak check, not the whole assertClean: naming `src/ci/dependabot.mjs` in this
  // repository's own copy is correct, because that is the one place it resolves. What
  // cannot be true anywhere is an instruction addressed to whoever maintains this tool.
  assertClean('dependabot (consumer)', renderDependabot(['has-pyproject'], { stack: ['node'] }));
  assertClean('dependabot (own)', renderDependabot(['has-pyproject'], { stack: ['node'], own: true }));
});

test('the config a repo gets lists exactly the ecosystems it has', async () => {
  const root = await actionsRepo({ 'pyproject.toml': '[project]\nname = "x"\n' });
  const plan = await planDependabot(root);
  assert.equal(plan.action, 'create');
  assert.deepEqual(plan.ecosystems, ['npm', 'pip']);
  const written = renderDependabot(plan.facts, { stack: plan.stack });
  assert.match(written, /package-ecosystem: "npm"/);
  assert.match(written, /package-ecosystem: "pip"/);
});

test('a repo with no .github gets no config, and is told why', async () => {
  // Same rule as the gate: creating `.github` silently would start opening dependency
  // pull requests nobody asked for.
  const root = await plainRepo();
  const plan = await planDependabot(root);
  assert.equal(plan.action, 'skip');
  assert.match(plan.reason, /does not run GitHub Actions/);
  await assert.rejects(readFile(join(root, DEPENDABOT_FILE), 'utf8'));
});

test('the config is never inspected for drift in a repo that adopted simt-dev', async () => {
  // The write-once rule in the one form that can be got wrong quietly. Both `init` and
  // `ci` route their writes through this plan, so a repo's config that this tool
  // compared against the template would be a repo's file being rewritten on their
  // next adoption - and the assertion the workflow's twin test makes, which has to be
  // made here too or the rule is only tested once and for one of two files.
  const root = await actionsRepo();
  await writeFile(join(root, DEPENDABOT_FILE), 'version: 2\nupdates:\n# ours\n');
  const plan = await planDependabot(root);
  assert.equal(plan.own, false);
  assert.equal(plan.action, 'unchanged');
  assert.equal(plan.reason, null);
});

test("a repo's own edits to the config survive init, exactly as the workflow's do", async () => {
  // The ownership rule in behavioural form. A repo that adds a private registry, an
  // `ignore` rule or a weekly cadence has done the thing this file exists to let them
  // do, and a second writer would delete it.
  const root = await actionsRepo();
  await exec('node', [BIN, 'init', '--surfaces', 'opencode', '--yes'], { cwd: root, env: { ...process.env, NO_COLOR: '1' } });
  await writeFile(
    join(root, DEPENDABOT_FILE),
    `${renderDependabot([], { stack: ['node'] })}\n# our own security policy lives here\n`,
  );
  await exec('node', [BIN, 'init', '--surfaces', 'opencode', '--yes'], { cwd: root, env: { ...process.env, NO_COLOR: '1' } });
  assert.match(await readFile(join(root, DEPENDABOT_FILE), 'utf8'), /our own security policy/);

  // And check does not inspect a file it did not write.
  const { stderr } = await exec('node', [BIN, 'check'], { cwd: root, env: { ...process.env, NO_COLOR: '1' } }).catch((e) => e);
  assert.doesNotMatch(stderr, /dependabot/);
});

test('check reports a repo that runs Actions but watches nothing', async () => {
  // The gate file alone does not make a repo safe to merge into: a repo whose
  // dependencies are never updated finds out about a CVE from an advisory rather
  // than from a pull request.
  const root = await actionsRepo();
  await exec('node', [BIN, 'init', '--surfaces', 'opencode', '--yes'], { cwd: root, env: { ...process.env, NO_COLOR: '1' } });
  await rm(join(root, DEPENDABOT_FILE));
  const { stdout, code } = await exec('node', [BIN, 'check'], { cwd: root, env: { ...process.env, NO_COLOR: '1' } }).catch((e) => e);
  assert.match(stdout, /ABSENT\s+\.github\/dependabot\.yml/);
  assert.match(stdout, /nothing watches its dependencies/);
  assert.equal(code, 1);

  await exec('node', [BIN, 'init', '--surfaces', 'opencode', '--yes'], { cwd: root, env: { ...process.env, NO_COLOR: '1' } });
  assert.ok((await exec('node', [BIN, 'check'], { cwd: root, env: { ...process.env, NO_COLOR: '1' } })).stdout);
});

test('simt-dev refreshes both of its own copies, and writes only what changed', async () => {
  const { stdout } = await exec('node', [BIN, 'ci'], { cwd: PACKAGE_ROOT, env: { ...process.env, NO_COLOR: '1' } });
  assert.match(stdout, /current\s+\.github\/workflows\/simt-dev-check\.yml/);
  assert.match(stdout, /current\s+\.github\/dependabot\.yml/);
});
