// The change record and the one function that applies it (review 0003 Q68).
//
// The point of the engine is that a writer cannot get the order wrong: it says what the
// path will hold, and create/update/unchanged are derived rather than passed in. These
// tests pin that derivation and the promise a rehearsal makes.
import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { applyPlan, change, pending } from '../src/write/plan.mjs';

test('the action is derived from the bytes, never passed in', () => {
  assert.equal(change({ path: 'a', before: null, after: 'x' }).action, 'create');
  assert.equal(change({ path: 'a', before: 'x', after: 'y' }).action, 'update');
  assert.equal(change({ path: 'a', before: 'x', after: 'x' }).action, 'unchanged');
  assert.equal(change({ path: 'a', kind: 'remove', before: 'x', after: null }).action, 'remove');
  assert.equal(change({ path: 'a', kind: 'remove', before: null, after: null }).action, 'unchanged');
  assert.throws(() => change({ path: 'a', kind: 'chmod', before: null, after: 'x' }), /unknown change kind/);
});

test('a rehearsal reports the plan and writes nothing', async () => {
  const root = await mkdtemp(join(tmpdir(), 'simt-plan-'));
  try {
    const plan = [change({ path: join(root, 'a.txt'), before: null, after: 'new' })];
    const result = await applyPlan(root, plan, { mode: { apply: false, dryRun: true }, label: 'test' });
    assert.equal(result.applied, false);
    assert.deepEqual(result.pending, [join(root, 'a.txt')]);
    await assert.rejects(readFile(join(root, 'a.txt'), 'utf8'), /ENOENT/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('applying writes every change in one journaled set', async () => {
  const root = await mkdtemp(join(tmpdir(), 'simt-plan-'));
  try {
    await writeFile(join(root, 'keep.txt'), 'old');
    const plan = [
      change({ path: 'keep.txt', before: 'old', after: 'new', owner: 'test' }),
      change({ path: 'deep/nested.txt', before: null, after: 'created', owner: 'test' }),
      change({ path: 'gone.txt', kind: 'remove', before: 'bye', after: null, owner: 'test' }),
    ];
    await writeFile(join(root, 'gone.txt'), 'bye');
    const result = await applyPlan(root, plan, { mode: { apply: true, dryRun: false }, label: 'test run' });
    assert.equal(result.applied, true);
    assert.equal(result.written.length, 3);
    assert.equal(await readFile(join(root, 'keep.txt'), 'utf8'), 'new');
    assert.equal(await readFile(join(root, 'deep/nested.txt'), 'utf8'), 'created');
    await assert.rejects(readFile(join(root, 'gone.txt'), 'utf8'), /ENOENT/);
    // One set, so undo restores the run rather than one file of it.
    assert.equal(result.journal.length, 3);
    assert.ok(result.journal.every((entry) => entry.path !== undefined));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('an unchanged plan applies nothing and commits nothing', async () => {
  const root = await mkdtemp(join(tmpdir(), 'simt-plan-'));
  try {
    const plan = [change({ path: 'a.txt', before: 'x', after: 'x' })];
    assert.deepEqual(pending(plan), []);
    const result = await applyPlan(root, plan, { mode: { apply: true }, label: 'test' });
    assert.equal(result.applied, false);
    assert.deepEqual(result.written, []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
