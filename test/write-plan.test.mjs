// Applying a plan verifies what it was built from, serializes writers, and keeps the
// window between the first write and the committed journal recoverable (review 0005 PR07).

import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { listJournalSets, undoLastJournalSet } from '../src/journal.mjs';
import { LOCAL_DIR } from '../src/state.mjs';
import { lockPath, withWriteLock, WriteBusy } from '../src/write/lock.mjs';
import { applyPlan, change, PlanConflict } from '../src/write/plan.mjs';
import { keepTemp } from './fixture.mjs';

async function repo() {
  const root = await mkdtemp(join(tmpdir(), 'simt-write-'));
  keepTemp(root);
  return root;
}

const read = (path) => readFile(path, 'utf8').catch(() => null);
const exists = (path) =>
  stat(path).then(
    () => true,
    () => false,
  );

test('a plan whose file changed after it was read refuses as a whole', async () => {
  const root = await repo();
  await writeFile(join(root, 'a.txt'), 'v1\n');
  await writeFile(join(root, 'b.txt'), 'b1\n');
  const plan = [change({ path: 'a.txt', before: 'v1\n', after: 'v2\n' }), change({ path: 'b.txt', before: 'b1\n', after: 'b2\n' })];
  // The user edits one of them while the plan is in flight.
  await writeFile(join(root, 'a.txt'), 'mine\n');

  await assert.rejects(() => applyPlan(root, plan, { mode: { apply: true }, label: 'test' }), (error) => {
    assert.ok(error instanceof PlanConflict);
    assert.equal(error.conflicts.length, 1);
    assert.match(error.conflicts[0].reason, /changed/);
    assert.match(error.message, /re-run the command/);
    return true;
  });
  assert.equal(await read(join(root, 'a.txt')), 'mine\n', 'the user edit survived');
  assert.equal(await read(join(root, 'b.txt')), 'b1\n', 'the unaffected change was not applied alone');
  assert.deepEqual(await listJournalSets(root), [], 'nothing was written, so nothing was recorded');
});

test('a create that appeared, and a directory where a file belongs, are conflicts', async () => {
  const root = await repo();
  await writeFile(join(root, 'appeared.txt'), 'theirs\n');
  await mkdir(join(root, 'dir'));
  const plan = [
    change({ path: 'appeared.txt', before: null, after: 'mine\n' }),
    change({ path: 'dir', before: null, after: 'file\n' }),
  ];
  await assert.rejects(() => applyPlan(root, plan, { mode: { apply: true }, label: 'test' }), PlanConflict);
  assert.equal(await read(join(root, 'appeared.txt')), 'theirs\n');
  assert.equal((await stat(join(root, 'dir'))).isDirectory(), true);
});

test('applying writes, journals one undoable set, and leaves no intent marker', async () => {
  const root = await repo();
  await writeFile(join(root, 'a.txt'), 'v1\n');
  const result = await applyPlan(root, [change({ path: 'a.txt', before: 'v1\n', after: 'v2\n' })], {
    mode: { apply: true },
    label: 'test',
  });
  assert.equal(result.applied, true);
  assert.equal(await read(join(root, 'a.txt')), 'v2\n');

  const dir = join(root, LOCAL_DIR, 'journal');
  const names = await readdir(dir);
  assert.equal(names.filter((n) => n.endsWith('.json')).length, 1);
  assert.deepEqual(names.filter((n) => n.endsWith('.pending')), [], 'the intent marker is removed once the set is committed');

  await undoLastJournalSet(root);
  assert.equal(await read(join(root, 'a.txt')), 'v1\n', 'the run is one undoable set');
});

test('a failure midway journals what landed, so the partial run is still undoable', async () => {
  const root = await repo();
  await writeFile(join(root, 'blocker'), 'not a directory\n');
  const plan = [
    change({ path: 'first.txt', before: null, after: 'one\n' }),
    // `blocker` is a regular file, so creating this path fails after the first write.
    change({ path: 'blocker/nested.txt', before: null, after: 'two\n' }),
  ];
  await assert.rejects(() => applyPlan(root, plan, { mode: { apply: true }, label: 'test' }));
  assert.equal(await read(join(root, 'first.txt')), 'one\n');
  assert.equal((await listJournalSets(root)).length, 1, 'the completed effect was recorded before the failure');

  await undoLastJournalSet(root);
  assert.equal(await exists(join(root, 'first.txt')), false, 'undo removes what the failed run created');
});

test('a live holder refuses rather than interleaving', async () => {
  const root = await repo();
  await mkdir(join(root, LOCAL_DIR), { recursive: true });
  await writeFile(lockPath(root), JSON.stringify({ pid: process.pid, at: new Date().toISOString() }));
  await assert.rejects(() => withWriteLock(root, async () => 'ran', { waitMs: 0 }), (error) => {
    assert.ok(error instanceof WriteBusy);
    assert.match(error.message, /another simt process is writing this repository/);
    return true;
  });
});

test('a lock left by a dead process is taken', async () => {
  const root = await repo();
  await mkdir(join(root, LOCAL_DIR), { recursive: true });
  await writeFile(lockPath(root), JSON.stringify({ pid: 2 ** 22 + 1, at: new Date().toISOString() }));
  assert.equal(await withWriteLock(root, async () => 'ran', { waitMs: 500 }), 'ran');
  assert.equal(await exists(lockPath(root)), false, 'the lock is released');
});

test('two concurrent applies serialize and both land', async () => {
  const root = await repo();
  const one = applyPlan(root, [change({ path: 'one.txt', before: null, after: '1\n' })], { mode: { apply: true }, label: 'one' });
  const two = applyPlan(root, [change({ path: 'two.txt', before: null, after: '2\n' })], { mode: { apply: true }, label: 'two' });
  const results = await Promise.all([one, two]);
  assert.deepEqual(
    results.map((r) => r.applied),
    [true, true],
  );
  assert.equal(await read(join(root, 'one.txt')), '1\n');
  assert.equal(await read(join(root, 'two.txt')), '2\n');
  assert.equal(await exists(lockPath(root)), false);
});
