// Plan 0004 W04: the metrics a single score would hide.
//
// Each case is a hand calculation against the plan's definitions, because an estimator
// that agrees with itself proves nothing. The three failure modes asserted here are the
// ones the row exists for: a knowledge gain cannot absorb a source regression, a local
// mock cannot read as remote correctness, and an inconclusive or underpowered experiment
// cannot enable a default.

import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  aggregateCost,
  coverage,
  costComponents,
  defaultEligibility,
  disclosureLine,
  knowledgeQuality,
  planSample,
  plannedSampleSize,
  remoteCorrectness,
  reportAccounting,
  stratify,
  summarizeQuality,
  verifiedOutcome,
} from '../packages/bench/src/accounting.mjs';

const record = (over = {}) => ({
  status: 'ok',
  measured: true,
  task: 't1',
  stratum: 'source',
  arm: 'bare',
  harness: 'gold',
  model: 'gold',
  rep: 1,
  resolved: true,
  gatesPassed: true,
  usage: { input: 100, cacheWrite: 0, cacheRead: 0, output: 50, turns: 2, toolCalls: 3 },
  diff: { files: 1, outsideBlastRadius: 0 },
  ...over,
});

test('a verified outcome needs every predicate, not just the hidden tests', () => {
  assert.equal(verifiedOutcome(record()), true);
  assert.equal(verifiedOutcome(record({ gatesPassed: false })), false);
  assert.equal(verifiedOutcome(record({ resolved: false })), false);
  assert.equal(verifiedOutcome(record({ status: 'error' })), false);
  assert.equal(verifiedOutcome(record({ measured: false })), false);
  assert.equal(verifiedOutcome(record({ hardConstraints: [{ passed: false }] })), false);
  assert.equal(verifiedOutcome(record({ evidence: { current: false } })), false);
  // An oracle harness calibrates the grader; its numbers are never an arm's measurement.
  assert.equal(verifiedOutcome(record({ measured: false, status: 'ok' })), false);
});

test('R_s is per stratum, and a repeat is folded into its task before the mean', () => {
  const records = [
    record({ task: 't1', rep: 1, resolved: true }),
    record({ task: 't1', rep: 2, resolved: false }),
    record({ task: 't2', resolved: true }),
    record({ task: 'k1', stratum: 'knowledge', resolved: true }),
  ];
  const strata = stratify(records, { samples: 50 });
  assert.deepEqual(strata.map((entry) => entry.stratum), ['knowledge', 'source']);
  const source = strata[1];
  assert.equal(source.tasks, 2, 'two tasks, not three runs');
  assert.equal(source.runs, 3);
  assert.equal(source.reps, 1.5);
  // t1's two reps average to 0.5, t2 is 1: the task mean is 0.75, not 2/3.
  assert.equal(source.R_s, 0.75);
  assert.equal(source.resolved, 2);
  assert.equal(strata[0].R_s, 1);
});

test('zero verified outcomes leave cost per outcome undefined, never zero', () => {
  const records = [record({ resolved: false }), record({ resolved: false, rep: 2 })];
  const [stratum] = stratify(records, { samples: 20 });
  assert.equal(stratum.R_s, 0);
  assert.equal(stratum.CPI, null);
});

test('coverage counts every unproven obligation in the denominator and by name', () => {
  const cov = coverage([
    { state: 'evidenced' },
    { state: 'evidenced' },
    { state: 'unrun' },
    { state: 'waived' },
    { state: 'unknown' },
    { state: 'unavailable' },
  ]);
  assert.equal(cov.numerator, 2);
  assert.equal(cov.denominator, 6);
  assert.equal(cov.V, 2 / 6);
  assert.deepEqual([cov.unrun, cov.waived, cov.unknown, cov.unavailable], [1, 1, 1, 1]);
  assert.equal(coverage([]).V, null, 'no obligations is not 100% coverage');
  assert.throws(() => coverage([{ state: 'fine' }]), /unknown obligation state "fine"/);
});

test('a knowledge hard failure is reported instead of averaged away', () => {
  const passed = knowledgeQuality({ entailment: 0.9, scope: 0.8, contradictions: 1, completeness: 0.7, structure: 0.6 });
  assert.equal(passed.score, 0.8);
  assert.equal(passed.graded, 5);
  const failed = knowledgeQuality({ entailment: 1, scope: 1, completeness: 1, structure: 1, hardFailure: 'contradicts the cited source' });
  assert.equal(failed.score, null);
  assert.equal(failed.hardFailure, 'contradicts the cited source');
  assert.equal(failed.dimensions.entailment, 1, 'the dimensions are still reported');
});

test('a local mock alone is not remote correctness', () => {
  const real = remoteCorrectness({ target: 1, delta: 1, postconditions: 1, frame: 1, convergence: 1 });
  assert.equal(real.score, 1);
  assert.equal(real.localMockOnly, false);
  const mocked = remoteCorrectness({ postconditions: 1, localMockOnly: true });
  assert.equal(mocked.score, null);
  assert.equal(mocked.localMockOnly, true);
  assert.equal(remoteCorrectness({ localMock: true }).score, null);
});

test('cost is reported by component, and a missing component nulls the total', () => {
  const partial = costComponents({ modelUsd: 1.5, humanReviewMinutes: 12, wallTimeSeconds: 900 });
  assert.equal(partial.components.modelUsd, 1.5);
  assert.equal(partial.components.humanReviewMinutes, 12);
  assert.equal(partial.components.toolUsd, null);
  assert.equal(partial.totalUsd, null);
  assert.deepEqual(partial.missing, ['toolUsd', 'remoteUsd']);
  const complete = costComponents({ modelUsd: 1.5, toolUsd: 0.25, remoteUsd: 0.25, retries: 2 });
  assert.equal(complete.totalUsd, 2);
  assert.equal(complete.components.retries, 2, 'retries stay a count, not dollars');
});

test('aggregate cost keeps priced and reported billing apart, and counts what is missing', () => {
  const withPrices = aggregateCost(
    [record({ usage: { input: 1_000_000, cacheWrite: 0, cacheRead: 0, output: 0 }, cost: { humanReviewMinutes: 10 } })],
    { kind: 'flat', entry: { in: 1, cache_write: 0, cache_read: 0, out: 0 } },
  );
  assert.equal(withPrices.modelBilling.priced, 1);
  assert.equal(withPrices.modelBilling.missing, 0);
  assert.equal(withPrices.modelBilling.usd, 1);
  assert.equal(withPrices.components.humanReviewMinutes, 10);

  const without = aggregateCost([record({ status: 'ok', usage: { input: 10, cacheWrite: 0, cacheRead: 0, output: 0 } })]);
  assert.equal(without.modelBilling.missing, 1);
  assert.equal(without.modelBilling.usd, null, 'an unpriced record must not total as free');
  assert.equal(without.components.humanReviewMinutes, null);
});

test('the sample size is the plan formula, checked by hand', () => {
  // ((1.6449 + 0.8416) * 0.5 / 0.1)^2 = 154.56 -> 155 tasks.
  assert.equal(plannedSampleSize({ sd: 0.5, delta: 0.1 }), 155);
  assert.throws(() => plannedSampleSize({ sd: 0, delta: 0.1 }), /positive pilot sd/);
  assert.throws(() => plannedSampleSize({ sd: 0.5, delta: 0 }), /positive delta/);
  assert.throws(() => plannedSampleSize({ sd: 0.5, delta: 0.1, alpha: 0.03 }), /no normal quantile/);
});

test('a thirty-task stratum is still a canary, and a shortfall is named', () => {
  const rows = [{ stratum: 'source', tasks: 30, reps: 3, sd: 0.5 }];
  const [plan] = planSample(rows, { delta: 0.02 });
  assert.equal(plan.required, 3865);
  assert.equal(plan.shortfall, 3835);
  assert.equal(plan.underpowered, true);
  assert.equal(plan.canary, false, '30 tasks at 3 reps is the canary size, not below it');
  assert.equal(planSample([{ stratum: 'ui', tasks: 5, reps: 1, sd: null }])[0].canary, true);
});

test('only non-inferior, powered, regression-free evidence may enable a default', () => {
  const nonInferior = { verdict: 'non-inferior', pairedTasks: 40 };
  const powered = [{ stratum: 'source', underpowered: false }];
  assert.deepEqual(defaultEligibility(nonInferior, { plan: powered, regressions: 0 }), {
    eligible: true,
    reasons: [],
    underpowered: [],
  });
  const inconclusive = defaultEligibility({ verdict: 'inconclusive' }, { plan: powered });
  assert.equal(inconclusive.eligible, false);
  assert.deepEqual(inconclusive.reasons, ['verdict-inconclusive']);
  assert.deepEqual(defaultEligibility(nonInferior, { plan: powered, regressions: 2 }).reasons, ['regressions']);
  assert.deepEqual(defaultEligibility(nonInferior, { plan: powered, strataLosses: ['knowledge'] }).reasons, ['stratum-loss']);
  assert.deepEqual(
    defaultEligibility(nonInferior, { plan: [{ stratum: 'ui', underpowered: true }] }).reasons,
    ['underpowered'],
  );
  assert.deepEqual(defaultEligibility(null).reasons, ['no-comparison']);
});

test('the disclosure names what was measured, excluded, repeated and unproven', () => {
  const records = [
    record({ task: 't1' }),
    record({ task: 't2' }),
    record({ status: 'error', error: 'agent timed out after 120000ms', resolved: false }),
  ];
  const accounting = reportAccounting(records, { samples: 20 });
  assert.match(accounting.disclosure, /2 task\(s\) over 1 stratum\(s\)/);
  assert.match(accounting.disclosure, /1 exclusion\(s\)/);
  assert.match(accounting.disclosure, /1 timeout\(s\)/);
  assert.match(accounting.disclosure, /coverage V not measured/);
  assert.match(accounting.disclosure, /still a canary/);
  assert.equal(accounting.cost.components.humanReviewMinutes, null);
  assert.equal(accounting.quality.knowledge.graded, 0);
});

test('the accounting block reports a knowledge score beside a source score, not instead of it', () => {
  const records = [
    record({ task: 'k1', stratum: 'knowledge', quality: { knowledge: { entailment: 1, scope: 0.5 } } }),
    record({ task: 'k2', stratum: 'knowledge', quality: { knowledge: { entailment: 0, scope: 0.5, hardFailure: 'unsupported claim' } } }),
    record({ task: 's1', stratum: 'source' }),
  ];
  const quality = summarizeQuality(records);
  assert.equal(quality.knowledge.graded, 1, 'a hard failure is not averaged into the score');
  assert.equal(quality.knowledge.hardFailures, 1);
  assert.deepEqual(quality.knowledge.dimensions, {
    entailment: 1,
    scope: 0.5,
    contradictions: null,
    completeness: null,
    structure: null,
  });
  const accounting = reportAccounting(records, { samples: 20 });
  assert.deepEqual(accounting.strataMetrics.map((entry) => entry.stratum), ['knowledge', 'source']);
  assert.equal(accounting.strataMetrics[1].R_s, 1);
  assert.equal(disclosureLine({ records, measured: records, strataMetrics: accounting.strataMetrics }).startsWith('Disclosure: 3 task'), true);
});
