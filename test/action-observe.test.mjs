// Plan 0004 W35: independent verification, convergence and frame checks.
//
// What the suite pins: an accepted request is not a result; a job that succeeded with the wrong
// object fails; eventually consistent data passes only after the declared stability window; a
// timeout stays unknown; an unrelated field changing fails the frame condition even when the
// desired result is correct; correlated channels are labelled; and no pass exists without a
// target, incarnation and revision.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import {
  ASSURANCE,
  OBSERVATION_VERDICTS,
  channelIndependence,
  jobState,
  verifyOutcome,
} from '../src/actions/observe.mjs';

const object = (fields = {}, over = {}) => ({
  target: 'rates/prod#inc-9',
  incarnation: 'inc-9',
  revision: 'rev-12',
  fields: { name: 'discount', audience: 'staff', ...fields },
  ...over,
});

const independent = [{ name: 'api', backing: 'primary' }, { name: 'db', backing: 'replica' }];

test('the verdicts and assurance labels are named', () => {
  assert.deepEqual(OBSERVATION_VERDICTS, ['pass', 'fail', 'incomplete', 'unknown']);
  assert.deepEqual(ASSURANCE, ['independent', 'correlated']);
});

test('an accepted request is not a result', () => {
  const result = verifyOutcome({ job: { state: 'accepted' }, object: object(), postconditions: [{ field: 'name', expect: 'discount' }], channels: independent });
  assert.equal(result.verdict, 'incomplete');
  assert.match(result.reasons[0], /accepted request is not a result/);
  assert.equal(jobState({ status: 202 }), 'pending');
});

test('a job that succeeded with the wrong object fails', () => {
  const result = verifyOutcome({
    job: { state: 'succeeded' },
    object: object({ name: 'something-else' }),
    postconditions: [{ field: 'name', expect: 'discount' }],
    channels: independent,
  });
  assert.equal(result.verdict, 'fail');
  assert.deepEqual(result.failed, ['name']);
});

test('eventual consistency passes only after the declared window and reads', () => {
  const early = verifyOutcome({ object: object(), postconditions: [{ field: 'name', expect: 'discount' }], channels: independent, stabilityWindow: 5000, elapsed: 1200 });
  assert.equal(early.verdict, 'incomplete');
  assert.match(early.reasons[0], /stable for the declared 5000ms window/);

  const oneRead = verifyOutcome({ object: object(), postconditions: [{ field: 'name', expect: 'discount' }], channels: independent, stabilityWindow: 5000, elapsed: 6000, stableReads: 1, requiredReads: 2 });
  assert.equal(oneRead.verdict, 'incomplete');

  const settled = verifyOutcome({ object: object(), postconditions: [{ field: 'name', expect: 'discount' }], channels: independent, stabilityWindow: 5000, elapsed: 6000, stableReads: 2, requiredReads: 2 });
  assert.equal(settled.verdict, 'pass');
  assert.deepEqual(settled.observed, { target: 'rates/prod#inc-9', incarnation: 'inc-9', revision: 'rev-12' });
});

test('a timeout stays unknown, never a pass', () => {
  const result = verifyOutcome({ object: object(), postconditions: [{ field: 'name', expect: 'discount' }], channels: independent, timedOut: true });
  assert.equal(result.verdict, 'unknown');
  assert.match(result.reasons[0], /remains unknown, not passed/);
});

test('an unrelated field changing fails the frame check', () => {
  const result = verifyOutcome({
    object: object({ audience: 'everyone' }),
    postconditions: [{ field: 'name', expect: 'discount' }],
    frames: [{ field: 'audience', expect: 'staff' }],
    channels: independent,
  });
  assert.equal(result.verdict, 'fail');
  assert.deepEqual(result.failed, ['audience']);
  assert.match(result.reasons[0], /frame condition violated/);
});

test('two channels behind one cache are correlated, not independent', () => {
  const shared = [{ name: 'api', backing: 'cache-1' }, { name: 'edge', backing: 'cache-1' }];
  assert.equal(channelIndependence(shared).assurance, 'correlated');
  assert.equal(channelIndependence(independent).assurance, 'independent');
  assert.equal(channelIndependence([{ name: 'only' }]).assurance, 'correlated');

  const result = verifyOutcome({ object: object(), postconditions: [{ field: 'name', expect: 'discount' }], channels: shared });
  assert.equal(result.verdict, 'pass');
  assert.equal(result.assurance, 'correlated');
  assert.match(result.reasons[0], /not independent confirmation/);
});

test('a pass names the target, the incarnation and the revision, or it is unknown', () => {
  const anonymous = verifyOutcome({ object: object({}, { incarnation: null }), postconditions: [{ field: 'name', expect: 'discount' }], channels: independent });
  assert.equal(anonymous.verdict, 'unknown');
  assert.match(anonymous.reasons[0], /cannot be current evidence/);

  const missing = verifyOutcome({ object: null, postconditions: [], channels: independent });
  assert.equal(missing.verdict, 'unknown');
});

test('the module is deterministic and reads nothing', async () => {
  const input = { object: object(), postconditions: [{ field: 'name', expect: 'discount' }], channels: independent };
  assert.deepEqual(verifyOutcome(input), verifyOutcome(input));
  const source = await readFile(new URL('../src/actions/observe.mjs', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /node:fs|node:net|fetch\(|process\.env|Date\.|Math\.random/);
});

// A postcondition over a field the object never carried compared `undefined` with `undefined` and
// passed; and a channel that declared no backing was treated as its own store.
import { channelIndependence as channelIndependenceForBacking, verifyOutcome as verifyOutcomeForAbsentField } from '../src/actions/observe.mjs';

test('a postcondition naming an absent field fails rather than passing on undefined', () => {
  const result = verifyOutcomeForAbsentField({
    object: { target: 'shop', incarnation: 'inc-1', revision: 'r1', fields: { name: 'discount' } },
    postconditions: [{ field: 'retiredAt', expect: undefined }],
    channels: [{ name: 'api', backing: 'primary' }, { name: 'db', backing: 'replica' }],
  });
  assert.equal(result.verdict, 'fail');
});

test('channels that declare no backing store are not independent', () => {
  const named = channelIndependenceForBacking([{ name: 'api' }, { name: 'db' }]);
  assert.equal(named.assurance, 'correlated');
  assert.match(named.reason, /no backing/);
  assert.equal(channelIndependenceForBacking([{ name: 'api', backing: 'primary' }, { name: 'db', backing: 'replica' }]).assurance, 'independent');
});
