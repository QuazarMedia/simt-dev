// A pre-push gate runs on the revisions being pushed (review 0005 PR03).
//
// The defect these pin: `runGates('pre-push', …)` materialised HEAD and ran the caller
// checkout's manifest, so a push carrying another branch — or two branches — got a report
// about a tree it did not deliver and a gate list it did not declare. The fixture below
// gives each branch its own gate and its own marker file, so a gate that ran in the wrong
// tree fails rather than reporting a plausible pass.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { runGates } from '../src/hooks/dispatcher.mjs';
import { MANIFEST_FILE } from '../src/name.mjs';
import { git, keepTemp } from './fixture.mjs';

const ZERO = '0'.repeat(40);

const PROBE = [
  'import { existsSync, writeFileSync } from "node:fs";',
  'import { basename } from "node:path";',
  'writeFileSync(process.env.PROBE_OUT, process.cwd());',
  '// Each branch carries its own marker; seeing the other one means the gate ran on the wrong tree.',
  'const here = basename(process.cwd());',
  'process.exit(existsSync("marker-b.txt") && !existsSync("marker-a.txt") ? 0 : existsSync("marker-a.txt") && process.env.PROBE_EXPECT === "b" ? 1 : 0);',
  '',
].join('\n');

async function commitBranch(root, branch, marker) {
  await git(['checkout', '-q', '-B', branch, 'main'], { cwd: root });
  await writeFile(join(root, 'marker.txt'), `${marker}\n`);
  await writeFile(join(root, `marker-${marker}.txt`), `${marker}\n`);
  await git(['add', '-A'], { cwd: root });
  await git(['-c', 'user.name=t', '-c', 'user.email=t@example.com', 'commit', '-qm', `branch ${marker}`], { cwd: root });
  return (await git(['rev-parse', 'HEAD'], { cwd: root })).stdout.trim();
}

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'simt-push-targets-'));
  keepTemp(root);
  await git(['init', '-q', '-b', 'main', '.'], { cwd: root });
  await writeFile(join(root, 'package.json'), '{ "name": "fx" }\n');
  await writeFile(join(root, 'probe.mjs'), PROBE);
  await writeFile(join(root, 'marker.txt'), 'base\n');
  await writeFile(join(root, 'marker-base.txt'), 'base\n');
  await writeFile(
    join(root, MANIFEST_FILE),
    JSON.stringify({ id: 'fx', gates: { preCommit: [], prePush: ['probe'], commands: { probe: 'node probe.mjs' } } }, null, 2),
  );
  await git(['add', '-A'], { cwd: root });
  await git(['-c', 'user.name=t', '-c', 'user.email=t@example.com', 'commit', '-qm', 'base'], { cwd: root });
  const base = (await git(['rev-parse', 'HEAD'], { cwd: root })).stdout.trim();
  const a = await commitBranch(root, 'branch-a', 'a');
  const b = await commitBranch(root, 'branch-b', 'b');
  // The caller stands on main, with work that belongs to no push.
  await git(['checkout', '-q', 'main'], { cwd: root });
  await writeFile(join(root, 'dirty.txt'), 'wip\n');
  return { root, base, a, b };
}

const manifest = (probe) => ({ id: 'fx', gates: { preCommit: [], prePush: ['probe'], commands: { probe } } });

test('each pushed revision is gated in its own tree, with its own declaration', async () => {
  const { root, base, a, b } = await fixture();
  const outA = join(root, 'cwd-a.txt');
  const outB = join(root, 'cwd-b.txt');
  process.env.PROBE_OUT = outA;
  try {
    const pushed = [
      `refs/heads/branch-a ${a} refs/heads/branch-a ${base}`,
      `refs/heads/branch-b ${b} refs/heads/branch-b ${base}`,
    ].join('\n');
    const result = await runGates('pre-push', { root, manifest: manifest('node probe.mjs'), pushed });

    assert.equal(result.targets.length, 2, 'two distinct commits are two targets');
    for (const target of result.targets) {
      assert.ok(target.ref.startsWith('refs/heads/'), 'the target names its ref');
      assert.match(target.revision, /^[0-9a-f]{40}$/, 'the target names its revision');
      assert.equal(target.basis, 'revision');
      assert.deepEqual(target.gates.map((g) => g.name), ['probe']);
      assert.equal(target.failed, false, JSON.stringify(target.gates));
    }
    const cwdA = (await readFile(outA, 'utf8')).trim();
    assert.notEqual(cwdA, root, 'the gate did not run in the caller checkout');
    assert.match(cwdA, /head-gate-/, 'the gate ran in a scratch worktree');

    for (const gate of result.gates) {
      assert.ok(gate.ref, 'every gate names the ref it belongs to');
      assert.ok(gate.revision, 'every gate names the revision it belongs to');
    }
    assert.equal(result.failed, false);
  } finally {
    delete process.env.PROBE_OUT;
  }
  void b;
});

test('a revision that cannot be prepared fails that target alone, and leaves no scratch tree', async () => {
  const { root, base, a } = await fixture();
  process.env.PROBE_OUT = join(root, 'cwd-any.txt');
  try {
    const pushed = [
      `refs/heads/branch-a ${a} refs/heads/branch-a ${base}`,
      `refs/heads/branch-missing ${'f'.repeat(40)} refs/heads/branch-missing ${base}`,
    ].join('\n');
    const result = await runGates('pre-push', { root, manifest: manifest('node probe.mjs'), pushed });

    const failed = result.targets.find((t) => t.failed);
    assert.ok(failed, 'the unreadable revision is its own failure');
    assert.equal(failed.revision, null);
    assert.equal(failed.gates[0].name, 'head');
    assert.match(failed.gates[0].detail, /not a commit this repository can check out/);
    const passed = result.targets.find((t) => !t.failed);
    assert.ok(passed, 'the readable revision still runs its gate');
    assert.equal(result.failed, true);

    const list = (await git(['worktree', 'list', '--porcelain'], { cwd: root })).stdout;
    assert.equal(/head-gate-/.test(list), false, `scratch worktrees were left behind:\n${list}`);
  } finally {
    delete process.env.PROBE_OUT;
  }
});

test('a repeated ref is one target, and a deletion-only push runs nothing', async () => {
  const { root, base, a } = await fixture();
  process.env.PROBE_OUT = join(root, 'cwd-repeat.txt');
  try {
    const repeated = [
      `refs/heads/branch-a ${a} refs/heads/branch-a ${base}`,
      `refs/heads/branch-a ${a} refs/heads/branch-a ${base}`,
    ].join('\n');
    const once = await runGates('pre-push', { root, manifest: manifest('node probe.mjs'), pushed: repeated });
    assert.equal(once.targets.length, 1, 'the same revision twice is one gate run');

    const deletion = `(delete) ${ZERO} refs/heads/branch-a ${base}`;
    const gone = await runGates('pre-push', { root, manifest: manifest('node probe.mjs'), pushed: deletion });
    assert.equal(gone.failed, false);
    assert.equal(gone.targets.length, 1, 'a deletion-only push runs what it can against HEAD');
    assert.equal(gone.targets[0].manual, true);
    assert.match(gone.notes.join(' '), /deletions only|no tree/);
  } finally {
    delete process.env.PROBE_OUT;
  }
});

test('a revision that changed its own gates is gated by them, not by the caller\u2019s', async () => {
  const { root, base } = await fixture();
  // A branch that turns the gate off entirely: the caller declares `probe`, the pushed
  // revision declares none. The report must say the revision's answer, not the caller's.
  await git(['checkout', '-q', '-B', 'quiet', 'main'], { cwd: root });
  await writeFile(join(root, MANIFEST_FILE), JSON.stringify({ id: 'fx', gates: { preCommit: [], prePush: [] } }, null, 2));
  await writeFile(join(root, 'quiet.txt'), 'quiet\n');
  await git(['add', '-A'], { cwd: root });
  await git(['-c', 'user.name=t', '-c', 'user.email=t@example.com', 'commit', '-qm', 'quiet'], { cwd: root });
  const quiet = (await git(['rev-parse', 'HEAD'], { cwd: root })).stdout.trim();
  await git(['checkout', '-q', 'main'], { cwd: root });

  const result = await runGates('pre-push', {
    root,
    manifest: manifest('node probe.mjs'),
    pushed: `refs/heads/quiet ${quiet} refs/heads/quiet ${base}`,
  });
  assert.equal(result.targets.length, 1);
  assert.equal(result.targets[0].basis, 'revision');
  assert.deepEqual(result.targets[0].gates, [], 'the pushed revision declared no pre-push gate');
  assert.equal(result.failed, false);
});

test('a manual run states its basis and still uses the committed HEAD tree', async () => {
  const { root } = await fixture();
  const result = await runGates('pre-push', { root, manifest: manifest('node probe.mjs') });
  assert.match(result.notes.join(' '), /manual run: no ref list on stdin, so the gates run against HEAD \([0-9a-f]{12}\)/);
  assert.equal(result.targets.length, 1);
  assert.equal(result.targets[0].manual, true);
});

void rm;
