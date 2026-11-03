// Plan 0004 W46: evaluation calibration and selective autonomy.
//
// What the suite pins: no autonomy without a bar declared before the numbers; an underpowered
// scope or a changed judge stays review-required; a clean measurement in one declared scope is the
// only path to autonomous; a hard privacy, security or effect constraint keeps the class under
// review whatever the average says; and the bound is a lower confidence bound, not a mean.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import {
  AUTONOMY,
  autonomy,
  calibration,
  judgeDigest,
  lowerBound,
  preregister,
} from '../src/bench/calibration.mjs';

const pairs = (counts, over = {}) => [
  ...Array.from({ length: counts.correct ?? 0 }, () => ({ model: 'accept', expert: 'accept', scope: 'rates', ...over })),
  ...Array.from({ length: counts.falseAccept ?? 0 }, () => ({ model: 'accept', expert: 'reject', scope: 'rates', ...over })),
  ...Array.from({ length: counts.correctReject ?? 0 }, () => ({ model: 'reject', expert: 'reject', scope: 'rates', ...over })),
];

const prereg = (over = {}) => preregister({ scope: 'rates', capability: 'docs', falseAcceptCeiling: 0.25, minSamples: 5, ...over });

test('the autonomy outcomes are named', () => {
  assert.deepEqual(AUTONOMY, ['autonomous', 'review-required', 'blocked']);
});

test('a bar cannot be declared without a ceiling and a sample size', () => {
  assert.throws(() => preregister({ scope: 'rates', minSamples: 5 }), /false-accept ceiling/);
  assert.throws(() => preregister({ scope: 'rates', falseAcceptCeiling: 0.2 }), /sample size/);
  assert.throws(() => preregister({ falseAcceptCeiling: 0.2, minSamples: 5 }), /scope/);
});

test('calibration reports false accepts, disagreement and the scoped counts', () => {
  const measured = calibration({
    pairs: [
      ...pairs({ correct: 2, falseAccept: 1, correctReject: 1 }),
      { model: 'accept', expert: 'accept', scope: 'docs', expertA: 'accept', expertB: 'reject' },
    ],
  });
  assert.equal(measured.samples, 5);
  assert.equal(measured.falseAccepts, 1);
  assert.equal(measured.disagreement, 1);
  assert.equal(measured.byScope.rates.samples, 4);
  assert.equal(measured.byScope.rates.falseAccepts, 1);
  assert.equal(measured.falseAcceptRate, 0.2);
});

test('no bar means no autonomy, whatever the numbers say', () => {
  const result = autonomy({ scope: 'rates', capability: 'docs', calibration: calibration({ pairs: pairs({ correct: 20 }) }) });
  assert.equal(result.decision, 'blocked');
  assert.match(result.reason, /declared after the numbers is not a bar/);
});

test('an underpowered scope stays review-required', () => {
  const result = autonomy({ scope: 'rates', capability: 'docs', prereg: prereg(), calibration: calibration({ pairs: pairs({ correct: 2 }) }) });
  assert.equal(result.decision, 'review-required');
  assert.match(result.reason, /underpowered: 2 of 5/);

  const otherScope = autonomy({ scope: 'billing', capability: 'docs', prereg: prereg(), calibration: calibration({ pairs: pairs({ correct: 20 }) }) });
  assert.equal(otherScope.decision, 'blocked');
  assert.match(otherScope.reason, /another scope or capability/);
});

test('a judge that changed invalidates the measurement', () => {
  const judge = { prompt: 'p1', model: 'm1', rubric: 'r1' };
  const result = autonomy({
    scope: 'rates',
    capability: 'docs',
    prereg: prereg({ judge }),
    judge: { prompt: 'p2', model: 'm1', rubric: 'r1' },
    calibration: calibration({ pairs: pairs({ correct: 20 }) }),
  });
  assert.equal(result.decision, 'review-required');
  assert.match(result.reason, /judge changed/);
  assert.equal(judgeDigest(judge), judgeDigest({ prompt: 'p1', model: 'm1', rubric: 'r1' }));
  assert.notEqual(judgeDigest(judge), judgeDigest({ prompt: 'p2', model: 'm1', rubric: 'r1' }));
});

test('a clean measurement in the declared scope may be autonomous', () => {
  // Five correct samples give a lower bound near 0.65, which is not enough to clear a 0.25
  // ceiling: the bound is deliberately conservative about small samples.
  const result = autonomy({ scope: 'rates', capability: 'docs', prereg: prereg(), calibration: calibration({ pairs: pairs({ correct: 20 }) }) });
  assert.equal(result.decision, 'autonomous');
  assert.ok(result.bound > 0.8);
  assert.match(result.reason, /lower confidence bound/);
});

test('a hard constraint outranks a good average', () => {
  const result = autonomy({
    scope: 'rates',
    capability: 'docs',
    prereg: prereg(),
    calibration: calibration({ pairs: pairs({ correct: 50 }) }),
    policy: { hardConstraints: ['privacy'] },
  });
  assert.equal(result.decision, 'review-required');
  assert.match(result.reason, /hard privacy, security or effect constraint/);
});

test('the bound is a lower bound, and it never exceeds the observed rate', () => {
  assert.equal(lowerBound({ successes: 0, samples: 0 }), 0);
  const bound = lowerBound({ successes: 3, samples: 4 });
  assert.ok(bound <= 0.75);
  assert.ok(bound > 0);
  assert.ok(lowerBound({ successes: 4, samples: 4 }) > bound);
});

test('the module is deterministic and reads nothing', async () => {
  const args = { scope: 'rates', capability: 'docs', prereg: prereg(), calibration: calibration({ pairs: pairs({ correct: 5 }) }) };
  assert.deepEqual(autonomy(args), autonomy(args));
  const source = await readFile(new URL('../src/bench/calibration.mjs', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /node:fs|node:net|fetch\(|process\.env|Date\.|Math\.random/);
});
