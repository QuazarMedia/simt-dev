// Plan 0004 W42: remote review bundles and promotion.
//
// What the suite pins: a bundle says whether it is planned, applied or verified; a reviewer can
// decide from it alone or the gaps are named; results are appended, never rewritten backwards; a
// promotion to another environment is a new intent with its own authorization; a raw environment
// id, a lossy bundle and a same-target promotion are rejected; and no call in the module mutates
// anything.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import {
  BUNDLE_SCHEMA,
  BUNDLE_STATES,
  appendResults,
  buildReviewBundle,
  checkBundle,
  promote,
} from '../src/actions/review.mjs';

const bundle = (over = {}) =>
  buildReviewBundle({
    contract: { commit: 'abc1234', digest: 'sha256-contract' },
    delta: { changes: [{ field: 'name', kind: 'changed', class: 'functional', before: 'discount', after: 'discount-v2' }] },
    target: { class: 'rest', incarnation: 'inc-1' },
    mappings: { 'rates/lead': 'id-1' },
    before: { 'rule:42': 'rev-3' },
    authorization: { digest: 'sha256-approval', scope: 'remote:write-object' },
    postconditions: [{ field: 'name', expect: 'discount-v2' }],
    risk: 'no independent channel was available',
    ...over,
  });

test('the schema and its three states are named', () => {
  assert.equal(BUNDLE_SCHEMA, 'simt.review-bundle/1');
  assert.deepEqual(BUNDLE_STATES, ['planned', 'applied', 'verified']);
});

test('a bundle needs the contract commit and an identified target', () => {
  assert.throws(() => buildReviewBundle({ target: { incarnation: 'inc-1' } }), /contract commit/);
  assert.throws(() => buildReviewBundle({ contract: { commit: 'abc' } }), /target incarnation/);
});

test('a planned bundle carries everything a review needs, and mutates nothing', () => {
  const planned = bundle();
  assert.equal(planned.state, 'planned');
  assert.equal(planned.mutates, false);
  assert.deepEqual(planned.contract, { commit: 'abc1234', digest: 'sha256-contract' });
  assert.equal(planned.delta.changes[0].after, 'discount-v2');
  assert.deepEqual(planned.target, { class: 'rest', incarnation: 'inc-1' });
  assert.deepEqual(planned.before, { 'rule:42': 'rev-3' });
  assert.deepEqual(planned.authorization, { digest: 'sha256-approval', scope: 'remote:write-object' });
  assert.equal(planned.receipts.length, 0);
  assert.match(planned.digest, /^sha256-/);
  assert.deepEqual(checkBundle(planned), { reviewable: true, missing: [], state: 'planned' });
});

test('the gaps that stop a review are named', () => {
  const thin = buildReviewBundle({
    contract: { commit: 'abc1234' },
    delta: { changes: [] },
    target: { incarnation: 'inc-1' },
    before: {},
    authorization: null,
    postconditions: [],
  });
  const check = checkBundle(thin);
  assert.equal(check.reviewable, false);
  assert.deepEqual(check.missing, ['the before revisions', 'the authorization scope', 'the postconditions']);
});

test('results are appended forward, and only forward', () => {
  const applied = appendResults(bundle(), { receipts: ['receipt-1'], observed: { revision: 'rev-4' } });
  assert.equal(applied.state, 'applied');
  assert.deepEqual(applied.receipts, ['receipt-1']);
  assert.deepEqual(applied.observed, { revision: 'rev-4' });
  assert.deepEqual(checkBundle(applied).missing, []);

  const verified = appendResults(applied, { verified: true });
  assert.equal(verified.state, 'verified');
  assert.throws(() => appendResults(verified, { receipts: ['x'] }), /cannot be appended to a verified bundle/);
});

test('an applied bundle with no receipt cannot be reviewed as applied', () => {
  const applied = appendResults(bundle(), { observed: { revision: 'rev-4' } });
  assert.deepEqual(checkBundle(applied).missing, ['the receipts for an applied bundle']);
});

test('promotion to another environment is a new intent', () => {
  const result = promote(bundle(), {
    target: { identity: 'rates/prod#inc-9', incarnation: 'inc-9' },
    mappings: { 'rates/lead': 'id-99' },
    authorization: { digest: 'sha256-new', scope: 'remote:write-object' },
    revisions: { 'rule:42': 'rev-7' },
  });
  assert.equal(result.promoted, true);
  assert.equal(result.intent.isNewIntent, true);
  assert.equal(result.intent.target.incarnation, 'inc-9');

  assert.equal(promote(bundle(), { target: { incarnation: 'inc-1' }, authorization: { digest: 'x' } }).promoted, false);
  assert.match(promote(bundle(), { target: { incarnation: 'inc-1' }, authorization: { digest: 'x' } }).rejected[0].reason, /already ran against/);
  assert.equal(promote(bundle(), { target: { incarnation: 'inc-9' } }).intent, null);
});

test('a raw environment id and a lossy bundle are refused by promotion', () => {
  const raw = bundle({ delta: { changes: [{ field: 'approver', kind: 'renamed', class: 'reference', after: '42' }] } });
  const result = promote(raw, { target: { incarnation: 'inc-9' }, mappings: {}, authorization: { digest: 'x' } });
  assert.equal(result.promoted, false);
  assert.match(result.rejected.map((entry) => entry.reason).join(' '), /environment-local ids/);

  const lossy = bundle({ delta: { changes: [{ field: 'name', kind: 'changed', class: 'functional' }], lossy: true } });
  assert.match(promote(lossy, { target: { incarnation: 'inc-9' }, mappings: {}, authorization: { digest: 'x' } }).rejected.map((entry) => entry.reason).join(' '), /lossy bundle/);
});

test('an unmapped reference is reported rather than dropped', () => {
  const reference = bundle({ delta: { changes: [{ field: 'approver', kind: 'renamed', class: 'reference', after: 'rates/lead' }] } });
  const result = promote(reference, { target: { incarnation: 'inc-9' }, mappings: {}, authorization: { digest: 'x' } });
  assert.deepEqual(result.unresolved, [{ ref: 'rates/lead', reason: 'unmapped in inc-9' }]);
});

test('the module is deterministic and reads nothing', async () => {
  assert.deepEqual(bundle(), bundle());
  const source = await readFile(new URL('../src/actions/review.mjs', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /node:fs|node:net|fetch\(|process\.env|Date\.|Math\.random/);
});
