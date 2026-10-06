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
import test, { after } from 'node:test';
import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

import { renderWorkflow, planWorkflow, WORKFLOW_FILE, WORKFLOWS_DIR } from '../src/ci/workflow.mjs';
import { renderShim, EVENTS } from '../src/hooks/shim.mjs';
import { PACKAGE_NAME, renderLocator } from '../src/locate.mjs';
import { assertClean } from './leaks.mjs';

const exec = promisify(execFile);
const BIN = new URL('../bin/simt-dev.mjs', import.meta.url).pathname;
const temps = [];

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
    remedy: 'REMEDY run: npm i -D @quazarmedia/simt-dev   (or unset core.hooksPath to opt out)',
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
  assert.match(yaml, /REMEDY run: npm i -D @quazarmedia\/simt-dev/);
});

test('a job that cannot find the tool fails rather than passes', () => {
  // The one outcome worse than a red build: a green tick from a check that never ran.
  // Every locator chain ends in a refusal with a non-zero exit, and the file says so,
  // because the next person to read this file is the one who has to believe it.
  const yaml = renderWorkflow();
  assert.match(yaml, /cannot locate simt-dev/);
  assert.match(yaml, /FAILS instead of passing/);
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
  assert.match(body.join('\n'), /simt-dev check|check --root/);

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
  assert.doesNotMatch(renderWorkflow(), /\bsimt (?!-dev\b)\w/);
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
  assert.match(first.stdout, /remedy: simt-dev init --yes/);

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
});

test('a repo with no .github is not told to have a workflow', async () => {
  const root = await plainRepo();
  const { stdout } = await exec('node', [BIN, 'check'], { cwd: root, env: { ...process.env, NO_COLOR: '1' } }).catch(
    (e) => e,
  );
  assert.doesNotMatch(stdout, /simt-dev-check\.yml/);
});
