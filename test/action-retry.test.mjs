// Plan 0004 W34: idempotency, preconditions and retry decisions.
//
// What the suite pins: a lost response after a create reconciles instead of retrying; a stale
// precondition halts rather than overwriting; an ambiguous match halts; a duplicate callback has
// one key and no second effect; backoff is deterministic, capped and deadline-bounded; the attempt
// budget stops rather than converting a failure into success; and no surface proves idempotency.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import {
  DECISIONS,
  OPERATION_CLASSES,
  backoff,
  classifyOperation,
  duplicateCallback,
  idempotencyKey,
  planRetry,
  precondition,
  simulateSchedule,
  surfaceProvesIdempotency,
} from '../src/actions/retry.mjs';

test('the operation classes and decisions are named', () => {
  assert.deepEqual(OPERATION_CLASSES, ['read', 'server-deduplicated', 'conditional-mutation', 'reconcilable-create', 'non-retryable']);
  assert.deepEqual(DECISIONS, ['retry', 'reconcile', 'halt', 'stop']);
});

test('an operation is classified by what the target guarantees', () => {
  assert.equal(classifyOperation({ method: 'GET' }), 'read');
  assert.equal(classifyOperation({ method: 'POST', serverDedup: true }), 'server-deduplicated');
  assert.equal(classifyOperation({ method: 'PATCH', precondition: precondition({ etag: 'W/"1"' }) }), 'conditional-mutation');
  assert.equal(classifyOperation({ method: 'POST', reconcilable: true }), 'reconcilable-create');
  assert.equal(classifyOperation({ method: 'POST', effect: 'create' }), 'non-retryable');
});

test('a lost response after a create reconciles before any retry', () => {
  const decision = planRetry({ operation: 'reconcilable-create', attempt: 1, error: 'lost-response' });
  assert.equal(decision.decision, 'reconcile');
  assert.equal(decision.halted, false);
  assert.match(decision.reason, /query the outcome by idempotency key/);

  assert.equal(planRetry({ operation: 'reconcilable-create', status: 503 }).decision, 'reconcile');
  assert.equal(planRetry({ operation: 'reconcilable-create', error: 'timeout' }).decision, 'reconcile');
});

test('a stale precondition halts instead of overwriting', () => {
  const decision = planRetry({ operation: 'conditional-mutation', attempt: 1, status: 412 });
  assert.equal(decision.decision, 'halt');
  assert.match(decision.reason, /would overwrite/);
  assert.equal(planRetry({ operation: 'conditional-mutation', error: 'stale-precondition' }).decision, 'halt');
});

test('an ambiguous name match halts', () => {
  const decision = planRetry({ operation: 'read', error: 'ambiguous-match' });
  assert.equal(decision.decision, 'halt');
  assert.match(decision.reason, /more than one object/);
});

test('the idempotency key is stable for the intent, step and target', () => {
  const key = idempotencyKey({ intentDigest: 'sha256-intent', step: 2, target: 'rates/prod#inc-9' });
  assert.match(key, /^simt-sha256-/);
  assert.equal(key, idempotencyKey({ intentDigest: 'sha256-intent', step: 2, target: 'rates/prod#inc-9' }));
  assert.notEqual(key, idempotencyKey({ intentDigest: 'sha256-intent', step: 3, target: 'rates/prod#inc-9' }));
  assert.equal(idempotencyKey({ step: 1, target: 'x' }), null);
});

test('a duplicate callback has an effect once', () => {
  const callback = { intentDigest: 'sha256-intent', step: 1, target: 'rates/prod#inc-9' };
  assert.deepEqual(duplicateCallback([callback], callback).duplicate, true);
  assert.equal(duplicateCallback([], callback).duplicate, false);
  assert.equal(duplicateCallback([{ other: true }], callback).key !== null, true);
  assert.equal(duplicateCallback([], {}).duplicate, false);
});

test('backoff is deterministic, capped and deadline-aware', () => {
  assert.equal(backoff({ attempt: 3, baseMs: 100, capMs: 5000, seed: 'x' }), backoff({ attempt: 3, baseMs: 100, capMs: 5000, seed: 'x' }));
  assert.ok(backoff({ attempt: 20, baseMs: 100, capMs: 5000, seed: 'x' }) <= 5000);
  const schedule = simulateSchedule({ attempts: 4, baseMs: 100, capMs: 5000, seed: 'x' });
  assert.equal(schedule.length, 4);
  assert.deepEqual(schedule, simulateSchedule({ attempts: 4, baseMs: 100, capMs: 5000, seed: 'x' }));

  const bounded = planRetry({ operation: 'read', attempt: 1, status: 503, elapsedMs: 29990, budget: { deadlineMs: 30000, baseMs: 1000, seed: 'x' } });
  assert.equal(bounded.decision, 'stop');
});

test('the attempt budget stops with the state preserved', () => {
  const decision = planRetry({ operation: 'read', attempt: 3, status: 503, budget: { attempts: 3 } });
  assert.equal(decision.decision, 'stop');
  assert.match(decision.reason, /preserved, not reclassified as success/);

  const nonRetryable = planRetry({ operation: 'non-retryable', attempt: 1 });
  assert.equal(nonRetryable.decision, 'halt');
});

test('a rate limit honours the declared wait, and a client error does not retry', () => {
  const limited = planRetry({ operation: 'read', status: 429, retryAfterMs: 2000, budget: { deadlineMs: 30000 } });
  assert.equal(limited.decision, 'retry');
  assert.equal(limited.delayMs, 2000);

  assert.equal(planRetry({ operation: 'read', status: 404 }).decision, 'halt');
  assert.equal(surfaceProvesIdempotency('UI submit').proves, false);
  assert.match(surfaceProvesIdempotency('a shell exit code').reason, /not that the target applied it once/);
});

test('the module is deterministic and reads nothing', async () => {
  assert.deepEqual(planRetry({ operation: 'read', status: 503 }), planRetry({ operation: 'read', status: 503 }));
  const source = await readFile(new URL('../src/actions/retry.mjs', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /node:fs|node:net|fetch\(|process\.env|Date\.|Math\.random/);
});

// The budget was consulted before the rejection, so a 400 on the last allowed attempt was reported
// as an exhausted budget rather than as the target refusing.
import { planRetry as planRetryForRejection } from '../src/actions/retry.mjs';

test('a rejection on the last allowed attempt is a rejection, not an exhausted budget', () => {
  const decision = planRetryForRejection({ operation: 'conditional-mutation', attempt: 3, status: 400, budget: { attempts: 3 } });
  assert.equal(decision.decision, 'halt');
  assert.match(decision.reason, /rejected the request \(400\)/);
});
