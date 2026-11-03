// Plan 0004 W44: procedure graduation and semantic conformance.
//
// What the suite pins: three validated independent runs are the minimum and are evidence to review
// rather than proof; a run that is not validated or not independent does not count; the proposal
// names common steps, branches and the environment-local values to parameterise; promotion needs a
// held-out variant and a failure path; the comparison is semantic, not transport; and one
// environment cannot establish portability whatever the hostname is called.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import {
  MIN_RUNS,
  PROPOSAL_STATES,
  differentialReplay,
  portability,
  promotionReady,
  proposeGraduation,
} from '../src/memory/graduation.mjs';

const trace = (environment = 'env-1', over = {}) => ({
  goal: 'publish',
  capability: 'rest',
  validated: true,
  environment,
  steps: ['read', 'write', 'verify'],
  values: ['77', 'rates.example.test'],
  ...over,
});

const three = () => [trace('env-1'), trace('env-2'), trace('env-3')];

test('the minimum and the proposal states are named', () => {
  assert.equal(MIN_RUNS, 3);
  assert.deepEqual(PROPOSAL_STATES, ['proposable', 'insufficient-evidence', 'blocked']);
});

test('two validated runs are not enough, and the reason says what would be', () => {
  const proposal = proposeGraduation({ traces: [trace('env-1'), trace('env-2')] }).proposals[0];
  assert.equal(proposal.state, 'insufficient-evidence');
  assert.equal(proposal.validated, 2);
  assert.match(proposal.reason, /3 are needed, and even 3 is evidence to review/);
});

test('an unvalidated or dependent run does not count', () => {
  const traces = [trace('env-1'), trace('env-2'), trace('env-3', { validated: false }), trace('env-4', { independent: false })];
  assert.equal(proposeGraduation({ traces }).proposals[0].validated, 2);
});

test('three runs propose the common steps, the branches and the parameters', () => {
  const traces = [trace('env-1'), trace('env-2'), trace('env-3', { steps: ['read', 'write', 'verify', 'compensate'], values: ['91'] })];
  const proposal = proposeGraduation({ traces }).proposals[0];
  assert.equal(proposal.state, 'proposable');
  assert.deepEqual(proposal.common, ['read', 'write', 'verify']);
  assert.deepEqual(proposal.branches, ['compensate']);
  assert.deepEqual(proposal.parameters, ['77', '91', 'rates.example.test']);
  assert.equal(proposal.requiresHeldOut, true);
  assert.equal(proposal.requiresFailurePath, true);
  assert.equal(proposal.humanReview, true);
});

test('promotion needs a held-out variant and a failure path', () => {
  const proposal = proposeGraduation({ traces: three() }).proposals[0];
  assert.equal(promotionReady({ proposal, heldOut: { passed: true }, failurePath: { passed: true } }).ready, true);

  const blocked = promotionReady({ proposal, heldOut: { passed: true }, failurePath: null });
  assert.equal(blocked.ready, false);
  assert.equal(blocked.state, 'blocked');
  assert.deepEqual(blocked.missing, ['a failure-path check that passes']);
  assert.equal(blocked.humanReview, true);
  assert.equal(promotionReady({ proposal: { state: 'insufficient-evidence' }, heldOut: { passed: true }, failurePath: { passed: true } }).ready, false);
});

test('differential replay compares the result, not the transport', () => {
  const reference = { fields: { name: 'discount', audience: 'staff' } };
  const helper = { fields: { name: 'discount', audience: 'staff' } };
  const result = differentialReplay({ reference, helper, postconditions: [{ field: 'name' }], frames: [{ field: 'audience', expect: 'staff' }] });
  assert.equal(result.equivalent, true);
  assert.equal(result.transportIdentical, false);
  assert.match(result.reason, /transport trace need not/);
});

test('a helper that reaches a different result is not equivalent', () => {
  const reference = { fields: { name: 'discount', audience: 'staff' } };
  const wrong = { fields: { name: 'discount-v2', audience: 'staff' } };
  const result = differentialReplay({ reference, helper: wrong, postconditions: [{ field: 'name' }], frames: [{ field: 'audience', expect: 'staff' }] });
  assert.equal(result.equivalent, false);
  assert.deepEqual(result.failed, [{ field: 'name', kind: 'postcondition' }]);

  const brokenFrame = differentialReplay({ reference, helper: { fields: { name: 'discount', audience: 'everyone' } }, postconditions: [{ field: 'name' }], frames: [{ field: 'audience', expect: 'staff' }] });
  assert.deepEqual(brokenFrame.failed, [{ field: 'audience', kind: 'frame' }]);
});

test('one environment cannot establish portability, whatever the hostname', () => {
  const single = portability([trace('env-1'), trace('env-1')]);
  assert.equal(single.portable, false);
  assert.match(single.reason, /single environment/);

  const multi = portability([trace('env-1'), trace('env-2')]);
  assert.equal(multi.portable, true);
  assert.deepEqual(multi.parameters, ['77', 'rates.example.test']);
});

test('the module is deterministic and reads nothing', async () => {
  assert.deepEqual(proposeGraduation({ traces: three() }), proposeGraduation({ traces: three() }));
  const source = await readFile(new URL('../src/memory/graduation.mjs', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /node:fs|node:net|fetch\(|process\.env|Date\.|Math\.random/);
});
