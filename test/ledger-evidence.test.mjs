// Evidence is about the tree the gate ran on (review 0005 PR04, ADR-197).
//
// The defect these pin: a line recorded from the caller's checkout while the gate ran in a
// detached worktree, an index tree accepted as if a gate had run on it, a timeout whose
// process exited 0 counted as a pass, and a changed command not cancelling an older pass.

import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { runGates } from '../src/hooks/dispatcher.mjs';
import { hasTestEvidence, readLedger, recordRun, treeId } from '../src/ledger/index.mjs';
import { MANIFEST_FILE } from '../src/name.mjs';
import { git, keepTemp } from './fixture.mjs';

async function repo() {
  const root = await mkdtemp(join(tmpdir(), 'simt-evidence-'));
  keepTemp(root);
  await git(['init', '-q', '-b', 'main', '.'], { cwd: root });
  await writeFile(join(root, 'a.txt'), 'a\n');
  await git(['add', '-A'], { cwd: root });
  await git(['-c', 'user.name=t', '-c', 'user.email=t@example.com', 'commit', '-qm', 'base'], { cwd: root });
  return root;
}

const sha = async (cwd, rev) => (await git(['rev-parse', rev], { cwd })).stdout.trim();

test('a record names the tree the gate ran in, not the tree the ledger lives in', async () => {
  const root = await repo();
  const head = await sha(root, 'HEAD');
  const tree = await sha(root, 'HEAD^{tree}');
  const wt = join(root, '..', `${root.split('/').pop()}-wt`);
  keepTemp(wt);
  await git(['worktree', 'add', '--detach', wt, head], { cwd: root });

  // The caller's checkout stops matching the executed tree.
  await writeFile(join(root, 'a.txt'), 'edited but uncommitted\n');

  const line = await recordRun(root, {
    cmd: 'npm test',
    exit: 0,
    ms: 5,
    output: 'ok',
    gate: 'test',
    kind: 'test',
    subject: wt,
    revision: head,
    toolchain: { node: 'test' },
  });
  assert.equal(line.tree, tree, 'the subject tree is the worktree the gate ran in');
  assert.equal(line.subjectTree, tree);
  assert.equal(line.revision, head);
  assert.equal(line.outcome, 'passed');
  assert.notEqual(line.tree, await treeId(root), 'the edited checkout is not the tree the gate proved');

  const { entries } = await readLedger(root);
  assert.equal(entries.at(-1).subjectTree, tree, 'the line on disk carries the subject tree');
});

test('an index tree is not evidence a gate ran, unless the question is about the index', () => {
  const entries = [
    { v: 2, tree: 'work', subjectTree: 'work', indexTree: 'staged', exit: 0, gate: 'test', kind: 'test', cmd: 'node --test', outcome: 'passed' },
  ];
  assert.equal(hasTestEvidence(entries, 'work'), true);
  assert.equal(hasTestEvidence(entries, 'staged'), false, 'no gate ran on the staged tree');
  // The commit-msg claim asks about the index the commit records, which the run named.
  assert.equal(hasTestEvidence(entries, 'staged', { basis: 'index' }), true);
  assert.equal(hasTestEvidence(entries, 'work', { basis: 'index' }), false);
});

test('the last run of the gate on a tree decides', () => {
  const pass = (cmd) => ({ v: 2, tree: 't', subjectTree: 't', exit: 0, gate: 'test', kind: 'test', cmd, outcome: 'passed' });
  const fail = (cmd) => ({ v: 2, tree: 't', subjectTree: 't', exit: 1, gate: 'test', kind: 'test', cmd, outcome: 'failed' });
  assert.equal(hasTestEvidence([pass('npm test')], 't'), true);
  assert.equal(hasTestEvidence([pass('npm test'), fail('npm test')], 't'), false, 'a later failure cancels the pass');
  assert.equal(
    hasTestEvidence([fail('npm test'), pass('npm test')], 't'),
    true,
    'the re-run after the fix is the evidence, not the failure it replaced',
  );
  // A changed command on the same source: the old command's pass is superseded by whatever
  // the repository ran last, so a failure under the new command cannot fall back to it.
  assert.equal(hasTestEvidence([pass('npm test'), fail('node --test')], 't'), false);
  assert.equal(hasTestEvidence([pass('npm test'), pass('node --test')], 't'), true);
});

test('a timed-out run is never a pass, whatever its process exited with', () => {
  const entries = [
    { v: 2, tree: 't', subjectTree: 't', exit: 0, gate: 'test', kind: 'test', cmd: 'npm test', outcome: 'timeout' },
  ];
  assert.equal(hasTestEvidence(entries, 't'), false, 'a timeout that exited 0 earned a skip');
});

test('a legacy line keeps its reading', () => {
  assert.equal(hasTestEvidence([{ v: 1, tree: 't', exit: 0, cmd: 'npm test' }], 't'), true);
  assert.equal(hasTestEvidence([{ v: 1, tree: 't', exit: 0, cmd: 'npm test' }], 'other'), false);
});

test('a push records the revision and the tree it executed in', async () => {
  const root = await repo();
  const base = await sha(root, 'HEAD');
  await writeFile(
    join(root, MANIFEST_FILE),
    JSON.stringify({ id: 'fx', gates: { preCommit: [], prePush: ['test'], commands: { test: 'node -e ""' } } }, null, 2),
  );
  await git(['add', '-A'], { cwd: root });
  await git(['-c', 'user.name=t', '-c', 'user.email=t@example.com', 'commit', '-qm', 'manifest'], { cwd: root });
  const head = await sha(root, 'HEAD');
  const tree = await sha(root, 'HEAD^{tree}');

  const pushed = `refs/heads/main ${head} refs/heads/main ${base}`;
  const result = await runGates('pre-push', {
    root,
    manifest: JSON.parse(await (await import('node:fs/promises')).readFile(join(root, MANIFEST_FILE), 'utf8')),
    pushed,
  });
  assert.equal(result.failed, false, JSON.stringify(result.gates));

  const { entries } = await readLedger(root);
  const line = entries.filter((e) => e.gate === 'test').at(-1);
  assert.ok(line, 'the run was recorded');
  assert.equal(line.subjectTree, tree, 'the line names the pushed tree');
  assert.equal(line.revision, head, 'the line names the pushed revision');
  assert.equal(line.outcome, 'passed');
  assert.ok(line.toolchain?.node, 'the line names the toolchain that ran it');
});
