// One answer to "where does this gate run, and may it" (review 0005 PR05).
//
// `check` and the dispatcher each had their own containment test, and they could disagree
// on a symlink, a canonical-equivalent spelling, or a linked worktree - always in the
// order that hurts: the check passes and the commit fails. These pin the shared resolver
// and the agreement, not just the message.

import assert from 'node:assert/strict';
import { mkdir, mkdtemp, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { checkRepo } from '../src/commands/sync.mjs';
import { runGates } from '../src/hooks/dispatcher.mjs';
import { resolveGateCwd } from '../src/hooks/cwd.mjs';
import { MANIFEST_FILE } from '../src/name.mjs';
import { git, keepTemp } from './fixture.mjs';

async function repo(manifest) {
  const root = await mkdtemp(join(tmpdir(), 'simt-gate-cwd-'));
  keepTemp(root);
  await git(['init', '-q', '-b', 'main', '.'], { cwd: root });
  await writeFile(join(root, 'a.txt'), 'a\n');
  await writeFile(join(root, MANIFEST_FILE), `${JSON.stringify(manifest, null, 2)}\n`);
  await mkdir(join(root, 'packages', 'x'), { recursive: true });
  // Git does not carry empty directories, so the package needs a file to exist in a
  // linked worktree - which is the tree this helper exists to exercise.
  await writeFile(join(root, 'packages', 'x', 'index.js'), 'export {};\n');
  await git(['add', '-A'], { cwd: root });
  await git(['-c', 'user.name=t', '-c', 'user.email=t@example.com', 'commit', '-qm', 'base'], { cwd: root });
  return root;
}

const readManifest = (root) => import('node:fs/promises').then(({ readFile }) => readFile(join(root, MANIFEST_FILE), 'utf8')).then(JSON.parse);

test('the resolver accepts the root, a package, and a canonical-equivalent spelling', async () => {
  const root = await repo({ id: 'fx', gates: { preCommit: ['test'], commands: { test: 'node -e ""' } } });
  assert.deepEqual(await resolveGateCwd(root, undefined, 'test'), { ok: true, path: root, declared: null });
  const plain = await resolveGateCwd(root, 'packages/x', 'test');
  const dressed = await resolveGateCwd(root, './packages/../packages/x/', 'test');
  assert.equal(plain.ok, true);
  assert.equal(dressed.ok, true);
  assert.equal(plain.path, dressed.path, 'two spellings of one directory are one directory');
});

test('a directory outside the repository, by text or by link, is refused', async () => {
  const root = await repo({ id: 'fx', gates: { preCommit: ['test'], commands: { test: 'node -e ""' } } });
  const outside = await mkdtemp(join(tmpdir(), 'simt-outside-'));
  keepTemp(outside);
  await symlink(outside, join(root, 'packages', 'escape'));

  const dotdot = await resolveGateCwd(root, '../outside', 'test');
  assert.equal(dotdot.ok, false);
  assert.equal(dotdot.status, 'gate-cwd-outside');

  const linked = await resolveGateCwd(root, 'packages/escape', 'test');
  assert.equal(linked.ok, false);
  assert.equal(linked.status, 'gate-cwd-outside', 'a link inside the repo that resolves outside is outside');

  const missing = await resolveGateCwd(root, 'packages/absent', 'test');
  assert.equal(missing.status, 'gate-cwd-missing');
});

test('check and dispatch agree on every invalid cwd', async () => {
  const manifest = { id: 'fx', gates: { preCommit: ['test'], commands: { test: 'node -e ""' }, cwd: { test: 'packages/absent' } } };
  const root = await repo(manifest);
  const findings = (await checkRepo(root)).findings.filter((f) => f.status.startsWith('gate-cwd-'));
  assert.equal(findings.length, 1);
  assert.equal(findings[0].gate, 'test');

  const run = await runGates('pre-commit', { root, manifest: await readManifest(root) });
  assert.equal(run.failed, true);
  assert.equal(run.gates[0].detail, findings[0].detail);
  assert.equal(run.gates[0].remedy, findings[0].remedy);
});

test('a nested package runs its own script in its own directory', async () => {
  const root = await repo({ id: 'fx', gates: { preCommit: ['test'], cwd: { test: 'packages/x' } } });
  await writeFile(join(root, 'packages', 'x', 'package.json'), JSON.stringify({ name: 'x', scripts: { test: 'node -e ""' } }));
  await git(['add', '-A'], { cwd: root });
  await git(['-c', 'user.name=t', '-c', 'user.email=t@example.com', 'commit', '-qm', 'nested'], { cwd: root });

  const manifest = await readManifest(root);
  assert.equal((await checkRepo(root)).findings.filter((f) => f.status.startsWith('gate-cwd-')).length, 0);
  const run = await runGates('pre-commit', { root, manifest });
  assert.equal(run.failed, false, JSON.stringify(run.gates));
});

test('a linked worktree resolves its own packages, and still refuses the parent', async () => {
  const root = await repo({ id: 'fx', gates: { preCommit: ['test'], commands: { test: 'node -e ""' }, cwd: { test: 'packages/x' } } });
  const linked = `${root}-linked`;
  keepTemp(linked);
  await git(['worktree', 'add', '--detach', linked, 'HEAD'], { cwd: root });

  const inside = await resolveGateCwd(linked, 'packages/x', 'test');
  assert.equal(inside.ok, true);
  assert.equal(inside.path, join(linked, 'packages', 'x'));

  // The linked worktree is its own root: the main checkout beside it is outside it,
  // whatever git says the two share.
  const parent = await resolveGateCwd(linked, '..', 'test');
  assert.equal(parent.ok, false);
  assert.equal(parent.status, 'gate-cwd-outside');
  await writeFile(join(linked, MANIFEST_FILE), `${JSON.stringify({ gates: { preCommit: ['test'], cwd: { test: 'nope' } } })}\n`);
  const run = await runGates('pre-commit', { root: linked, manifest: await readManifest(linked) });
  assert.equal(run.failed, true, 'the gate fails from the linked worktree too');
  assert.match(run.gates[0].detail, /not a directory/);
});
