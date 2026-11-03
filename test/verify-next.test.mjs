// Plan 0004 W21: missing-proof and next-observation planning.
//
// The suite is built around the two choices the design names: a targeted revision read over a
// full dump, and a source-date clarification over a generation nobody supports. Around them it
// pins the properties that keep a planner from becoming a browsing loop: constraints remove
// options before ranking, a probability exists only with its denominator, unknown cost is
// labelled, every offer is a suggestion, and a stop names the missing capability or decision
// with `retry: false`.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import { MISSING_KINDS, NEXT_SCHEMA_VERSION, planNext } from '../src/verify/next.mjs';

const unmet = (id, over = {}) => ({ id, state: 'unknown', ...over });
const capability = (id, over = {}) => ({ id, kind: 'targeted-read', obligations: ['rate'], latency: 2, cost: 1, discrimination: 0.5, ...over });

test('the planner suggests and never invokes', () => {
  assert.equal(NEXT_SCHEMA_VERSION, 1);
  assert.deepEqual(MISSING_KINDS, ['capability', 'decision']);
  const report = planNext({ obligations: [unmet('rate')], capabilities: [capability('read-rate')] });
  assert.equal(report.invoked, false);
  assert.equal(report.offers[0].status, 'suggested');
  assert.equal(report.offers[0].executed, false);
  assert.equal(report.offers[0].requiresInvocation, true);
});

test('a targeted revision read beats a full dump at the same coverage', () => {
  const report = planNext({
    obligations: [unmet('rate')],
    capabilities: [
      capability('full-dump', { kind: 'full-dump', latency: 4, cost: 3, discrimination: 0.2 }),
      capability('targeted-read', { kind: 'targeted-read', latency: 2, cost: 1, discrimination: 0.9 }),
    ],
  });
  assert.deepEqual(report.offers.map((offer) => offer.id), ['targeted-read', 'full-dump']);
  assert.ok(report.offers[0].score > report.offers[1].score);
});

test('a source-date clarification is offered where generation is unsupported', () => {
  const report = planNext({
    obligations: [unmet('rate')],
    capabilities: [
      capability('generate-rate', { kind: 'generation', supported: false }),
      capability('ask-for-source-date', { kind: 'source-date-clarification', requiresNetwork: false, latency: 1, cost: 1 }),
    ],
  });
  assert.deepEqual(report.offers.map((offer) => offer.id), ['ask-for-source-date']);
  assert.deepEqual(report.excluded, [{ id: 'generate-rate', reason: 'unsupported' }]);
});

test('constraints remove an option before it is ranked, and say which one', () => {
  const report = planNext({
    obligations: [unmet('rate')],
    capabilities: [capability('remote-read', { requiresNetwork: true }), capability('local-read', { requiresNetwork: false })],
    constraints: { network: false },
  });
  assert.deepEqual(report.offers.map((offer) => offer.id), ['local-read']);
  assert.deepEqual(report.excluded, [{ id: 'remote-read', reason: 'network' }]);

  const noActor = planNext({
    obligations: [unmet('rate')],
    capabilities: [capability('write', { requiresActor: 'writer' })],
    constraints: { actors: ['reader'] },
  });
  assert.deepEqual(noActor.excluded, [{ id: 'write', reason: 'actor' }]);
  assert.equal(noActor.stop.reason, 'no-admissible-action');
});

test('a rate appears only with a denominator, and unknown cost is labelled', () => {
  const without = planNext({ obligations: [unmet('rate')], capabilities: [capability('unmeasured')] });
  assert.equal(without.offers[0].basis, 'ordinal');
  assert.equal(without.offers[0].probability, null);
  assert.equal(without.offers[0].attempts, null);

  const withHistory = planNext({
    obligations: [unmet('rate')],
    capabilities: [capability('measured')],
    history: [{ capability: 'measured', attempts: 4, successes: 3 }, { capability: 'measured', attempts: 0, successes: 0 }],
  });
  assert.equal(withHistory.offers[0].basis, 'measured');
  assert.equal(withHistory.offers[0].probability, 0.75);
  assert.equal(withHistory.offers[0].attempts, 4);
  for (const offer of withHistory.offers) {
    if (offer.probability !== null) assert.ok(offer.attempts > 0, `${offer.id} has a probability with no denominator`);
  }

  const unpriced = planNext({ obligations: [unmet('rate')], capabilities: [capability('unpriced', { cost: null })] });
  assert.equal(unpriced.offers[0].costBasis, 'unknown');
  assert.equal(unpriced.offers[0].cost, null);
  assert.equal(unpriced.offers[0].executed, false);
});

test('a budget of zero excludes by budget and stops rather than retrying', () => {
  const report = planNext({
    obligations: [unmet('rate')],
    capabilities: [capability('expensive', { cost: 3 })],
    constraints: { budget: 0 },
  });
  assert.deepEqual(report.excluded, [{ id: 'expensive', reason: 'budget' }]);
  assert.equal(report.offers.length, 0);
  assert.equal(report.stop.reason, 'no-admissible-action');
  assert.equal(report.stop.retry, false);
  assert.deepEqual(report.stop.missing, [{ obligation: 'rate', kind: 'capability', detail: 'no declared capability discharges rate within the stated constraints' }]);
});

test('a stop names the decision when the obligation needs one', () => {
  const report = planNext({ obligations: [unmet('rate', { requiresDecision: true })] });
  assert.equal(report.stop.missing[0].kind, 'decision');
  assert.match(report.stop.missing[0].detail, /needs a decision/);
  assert.deepEqual(planNext({ obligations: [unmet('rate', { requiresDecision: true })] }), report, 'the stop changed between two identical calls');
});

test('an obligation already settled is not part of the question', () => {
  const report = planNext({
    obligations: [
      { id: 'done', state: 'pass' },
      { id: 'waived', state: 'waived' },
      { id: 'flat', state: 'not-applicable' },
      unmet('rate'),
    ],
    capabilities: [capability('read-rate', { obligations: ['rate', 'done'] })],
  });
  assert.deepEqual(report.unmet.map((obligation) => obligation.id), ['rate']);
  assert.deepEqual(report.offers[0].covers, ['rate']);
  assert.equal(report.offers[0].expectedCoverage, 1);
});

test('a capability whose predicate kind cannot discharge the obligation is not an option', () => {
  const report = planNext({
    obligations: [unmet('rate', { predicate: { kind: 'entailment' } })],
    capabilities: [capability('formatter-run', { predicateKinds: ['format'] })],
  });
  assert.deepEqual(report.excluded, [{ id: 'formatter-run', reason: 'does-not-discharge' }]);
  assert.equal(report.stop.missing[0].kind, 'capability');
});

test('the plan is deterministic and reads nothing', async () => {
  const input = {
    obligations: [unmet('a'), unmet('b', { state: 'fail' })],
    capabilities: [capability('one', { obligations: ['a'] }), capability('both', { coverage: 'all' })],
    constraints: { network: true, budget: 5 },
    history: [{ capability: 'both', attempts: 2, successes: 1 }],
  };
  assert.deepEqual(planNext(input), planNext(structuredClone(input)));
  const source = await readFile(new URL('../src/verify/next.mjs', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /node:fs|node:net|fetch\(|process\.env|Date\.|Math\.random/);
});
