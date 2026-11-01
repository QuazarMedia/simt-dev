// Plan 0004 W03: the transition model itself.
//
// The model is only evidence if it is deterministic and if every named fault is actually
// reachable at a boundary. Both are asserted here, plus the control the slice exists for:
// a naive retry duplicates a create and the oracle says so, while a retry carrying the
// idempotency key reconciles.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import { FAULTS, oracleVerdict, runWorld, seededRandom } from '../packages/bench/src/work-world.mjs';

const CREATE = { op: 'create', objectId: 'obj-1', fields: { name: 'first' }, idempotencyKey: 'k1' };

test('the same schedule and seed produce identical receipts and world state', () => {
  const events = [
    CREATE,
    { op: 'read', objectId: 'obj-1' },
    { op: 'update', objectId: 'obj-1', fields: { name: 'second' }, idempotencyKey: 'k2' },
    { op: 'batch', objectId: 'row', batch: 4 },
    { op: 'callback', objectId: 'obj-1', idempotencyKey: 'k1' },
  ];
  const first = runWorld(events, { seed: 42 });
  const second = runWorld(events, { seed: 42 });
  assert.deepEqual(second.receipts, first.receipts);
  assert.deepEqual([...second.objects.entries()], [...first.objects.entries()]);
  assert.deepEqual(second.oracle, first.oracle);
});

test('the seed decides which faults occur, and a different seed is a different campaign', () => {
  const events = Array.from({ length: 40 }, (_, index) => ({
    op: 'update',
    objectId: `obj-${index % 3}`,
    fields: { index },
    idempotencyKey: `k-${index}`,
  }));
  const observed = new Set();
  for (let seed = 0; seed < 25; seed += 1) {
    for (const receipt of runWorld(events, { seed }).receipts) if (receipt.fault !== null) observed.add(receipt.fault);
  }
  for (const fault of FAULTS) assert.ok(observed.has(fault), `${fault} is never injected by any seed`);
});

test('every named fault is injectable at its own boundary', () => {
  const cases = {
    // A key of its own: reusing k1 would be a reconciliation, which is the behaviour one
    // test below already owns.
    'response-loss-after-commit': { ...CREATE, idempotencyKey: 'k-loss' },
    'stale-read': { op: 'read', objectId: 'obj-1' },
    'target-reset': { ...CREATE },
    'conflicting-writer': { ...CREATE, idempotencyKey: 'k-conflict' },
    'partial-batch': { op: 'batch', objectId: 'row', batch: 4 },
    'transport-fallback': { ...CREATE, idempotencyKey: 'k-transport' },
    'callback-duplication': { op: 'callback', objectId: 'obj-1', idempotencyKey: 'k1' },
  };
  for (const fault of FAULTS) {
    const events = [CREATE, { op: 'read', objectId: 'obj-1' }, { ...cases[fault], fault }];
    const world = runWorld(events, { faults: 'explicit' });
    const last = world.receipts.at(-1);
    assert.equal(last.fault, fault, `${fault} was not recorded on the event that asked for it`);
    if (fault === 'response-loss-after-commit') {
      assert.equal(last.status, 'timeout');
      // The first event committed revision 1; the faulted one committed revision 2 and
      // then lost the response. The effect landing is the whole point of the fault.
      assert.equal(last.revision, 2, 'the effect landed even though the caller timed out');
    }
    if (fault === 'stale-read') assert.equal(last.revision, 1, 'a stale read reports the previous revision');
    if (fault === 'partial-batch') assert.deepEqual({ applied: last.applied, requested: last.requested }, { applied: 2, requested: 4 });
  }
});

test('a naive retry duplicates the create; a keyed retry reconciles it', () => {
  const timeout = { ...CREATE, fault: 'response-loss-after-commit' };
  const naive = runWorld([timeout, { op: 'create', objectId: 'obj-1', fields: { name: 'first' } }], { faults: 'explicit' });
  assert.notEqual(oracleVerdict(naive, { expectEffects: 1 }).ok, true, 'a create applied twice has to fail the oracle');
  assert.equal(naive.oracle.effects.length, 2);

  const keyed = runWorld([timeout, { ...CREATE, idempotencyKey: 'k1' }], { faults: 'explicit' });
  assert.deepEqual(oracleVerdict(keyed, { expectEffects: 1 }), {
    ok: true,
    effects: 1,
    duplicates: [],
    resets: 0,
  });
  assert.equal(keyed.receipts.at(-1).status, 'reconciled');
});

test('a duplicate delivery and a surplus effect are different facts, and both are recorded', () => {
  const world = runWorld(
    [
      { ...CREATE, fault: 'response-loss-after-commit' },
      { ...CREATE, idempotencyKey: undefined },
      { op: 'callback', objectId: 'obj-1', idempotencyKey: 'k1', fault: 'callback-duplication' },
    ],
    { faults: 'explicit' },
  );
  // The keyed write committed twice (the timeout and the keyless retry), so two effects
  // are correct here; the callback was then delivered twice for the same key.
  assert.deepEqual(oracleVerdict(world, { expectEffects: 2 }), {
    ok: true,
    effects: 2,
    duplicates: [],
    resets: 0,
  });
  assert.equal(world.oracle.duplicates.length, 1, 'the duplicate delivery is recorded in the oracle channel');
  // A surplus effect is caught by count, which is why the count is part of the verdict.
  assert.equal(oracleVerdict(world, { expectEffects: 1 }).ok, false, 'an unasked-for effect has to fail the oracle');
});

test('the model opens no socket and reads no credential', async () => {
  const source = await readFile(new URL('../packages/bench/src/work-world.mjs', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /node:net|node:http|node:https|fetch\(|process\.env/);
  // And the PRNG is stable across runs, which is what makes the seeded campaign a fixture.
  assert.equal(seededRandom(7)(), seededRandom(7)());
});
