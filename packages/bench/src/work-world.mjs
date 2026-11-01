// A deterministic world for external work: objects, revisions, actors and effects.
//
// The hard part of remote and UI work is not the happy path; it is a request that
// committed and then lost its response, a read that was already stale when it arrived,
// a batch that applied half of itself, or a callback delivered twice. None of those can
// be reproduced against a live system on demand, so this module models them instead:
// one logical clock, one seeded event schedule, and every fault injectable at the
// boundary where it happens.
//
// Two rules make the model usable as evidence rather than decoration:
//
//   * The same schedule and seed produce identical receipts and identical world state,
//     so a failing case is a fixture, not an anecdote.
//   * The authoritative effects live in `oracle`, a channel no receipt carries. A
//     receipt that says "created" is the attempt's account of itself; the oracle is what
//     happened, and the two are compared by the grader.
//
// Nothing here opens a socket, reads a credential or calls a service. The "remote" is a
// Map, and that is the point: the failure modes are real, the side effects are not.

/** Every fault the world can inject, named for the boundary it occurs at. */
export const FAULTS = Object.freeze([
  'response-loss-after-commit',
  'stale-read',
  'target-reset',
  'conflicting-writer',
  'partial-batch',
  'transport-fallback',
  'callback-duplication',
]);

/** Deterministic PRNG: the same seed and event index always choose the same fault. */
export function seededRandom(seed) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function receiptOf(event, fields) {
  return { event: event.index, op: event.op, target: event.objectId ?? null, ...fields };
}

/**
 * Run a schedule against a fresh world.
 *
 * `events` are `{op, objectId, actor, fields, idempotencyKey, batch, fault}`. A named
 * `fault` is injected verbatim; `faults: 'seeded'` selects one for the event from the
 * seed, which is what makes a whole campaign reproducible from two numbers.
 */
export function runWorld(events, { seed = 1, faults = 'seeded' } = {}) {
  const random = seededRandom(seed);
  const world = {
    clock: 0,
    objects: new Map(),
    receipts: [],
    // The authoritative record. Receipts never read it; the grader never reads anything
    // else.
    oracle: { effects: [], duplicates: [], resets: [] },
  };
  const applied = new Map();

  const commit = (objectId, fields, actor, idempotencyKey) => {
    const current = world.objects.get(objectId);
    const revision = current === undefined ? 1 : current.revision + 1;
    const object = { id: objectId, revision, fields: { ...(current?.fields ?? {}), ...fields }, actor };
    world.objects.set(objectId, object);
    const effect = { objectId, revision, actor, idempotencyKey: idempotencyKey ?? null };
    world.oracle.effects.push(effect);
    if (idempotencyKey !== undefined) applied.set(idempotencyKey, effect);
    return object;
  };

  for (const [index, raw] of events.entries()) {
    world.clock += 1;
    const event = { index, ...raw };
    const fault = event.fault ?? (faults === 'seeded' ? (random() < 0.5 ? FAULTS[Math.floor(random() * FAULTS.length)] : null) : null);

    // A retry carrying the key of an effect that already landed is the reconciliation the
    // naive path does not do: it answers with the committed revision instead of a second
    // write.
    if (event.idempotencyKey !== undefined && applied.has(event.idempotencyKey) && event.op !== 'callback') {
      world.receipts.push(receiptOf(event, { status: 'reconciled', revision: applied.get(event.idempotencyKey).revision, fault }));
      continue;
    }

    if (event.op === 'read') {
      const object = world.objects.get(event.objectId);
      if (object === undefined) {
        world.receipts.push(receiptOf(event, { status: 'absent', fault }));
        continue;
      }
      const revision = fault === 'stale-read' ? Math.max(1, object.revision - 1) : object.revision;
      world.receipts.push(receiptOf(event, { status: 'read', revision, fields: { ...object.fields }, fault }));
      continue;
    }

    if (event.op === 'callback') {
      // Duplicate delivery is a property of the channel, not of the subscriber: the
      // effect is counted once when the key is known, twice when it is not.
      const key = event.idempotencyKey;
      if (fault === 'callback-duplication' && key !== undefined && applied.has(key)) {
        world.oracle.duplicates.push({ objectId: event.objectId, idempotencyKey: key });
        world.receipts.push(receiptOf(event, { status: 'duplicate', fault }));
        continue;
      }
      world.receipts.push(receiptOf(event, { status: 'delivered', fault }));
      continue;
    }

    if (event.op === 'batch') {
      const count = event.batch ?? 3;
      const appliedCount = fault === 'partial-batch' ? Math.max(1, Math.floor(count / 2)) : count;
      for (let item = 0; item < appliedCount; item += 1) {
        commit(`${event.objectId}-${item}`, event.fields ?? { item }, event.actor ?? 'agent', undefined);
      }
      world.receipts.push(receiptOf(event, { status: 'batch', applied: appliedCount, requested: count, fault }));
      continue;
    }

    if (fault === 'conflicting-writer') {
      // Someone else advanced the object between the read and the write: the write is
      // refused rather than silently overwriting them.
      commit(event.objectId, { conflicted: true }, 'someone-else', undefined);
      world.receipts.push(receiptOf(event, { status: 'conflict', fault }));
      continue;
    }

    if (fault === 'target-reset') {
      world.objects.delete(event.objectId);
      world.oracle.resets.push({ objectId: event.objectId });
      world.receipts.push(receiptOf(event, { status: 'reset', fault }));
      continue;
    }

    if (fault === 'transport-fallback') {
      world.receipts.push(receiptOf(event, { status: 'transport-refused', fault }));
    }

    const object = commit(event.objectId, event.fields ?? {}, event.actor ?? 'agent', event.idempotencyKey);
    if (fault === 'response-loss-after-commit') {
      // Committed, and the caller was told nothing. This is the fault that makes retry
      // safety a correctness property rather than a nicety.
      world.receipts.push(receiptOf(event, { status: 'timeout', revision: object.revision, fault }));
      continue;
    }
    world.receipts.push(receiptOf(event, { status: 'created', revision: object.revision, fault: fault ?? null }));
  }

  return world;
}

/**
 * The verdict, read from the oracle rather than from receipts.
 *
 * `expectEffects` is the count a correct attempt should have produced. A duplicate is an
 * effect the same idempotency key produced twice; a surplus is an effect nobody asked
 * for. Both are failures even when every receipt reads success.
 */
export function oracleVerdict(world, { expectEffects = null } = {}) {
  const keys = world.oracle.effects.map((effect) => effect.idempotencyKey).filter((key) => key !== null);
  const duplicates = keys.filter((key, index) => keys.indexOf(key) !== index);
  return {
    ok: duplicates.length === 0 && (expectEffects === null || world.oracle.effects.length === expectEffects),
    effects: world.oracle.effects.length,
    duplicates: [...new Set(duplicates)],
    resets: world.oracle.resets.length,
  };
}
