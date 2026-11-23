import assert from 'node:assert/strict';
import { test } from 'node:test';

import { runRetrievalAblation } from '../packages/bench/src/ablate.mjs';
import { PROMOTION_GATE_BARS, RETRIEVAL_ARMS, evaluateRetrievalGates, renderRetrievalAblation } from '../packages/bench/src/retrieval-ablation.mjs';
import { measureMapPhases } from '../packages/bench/src/retrieval-metrics.mjs';

const V2_FEATURES = ['bm25f-ident', 'guarded-prf', 'directional-graph', 'symbol-bind', 'decompose', 'submodular-pack', 'cochange', 'governance'];
const TRACK_A = ['anchor-fix', 'kind-notest', 'bm25f-bf', 'intent-project', 'fair-pack'];
const TRACK_B = ['commit-ir', 'pmi-thesaurus', 'qpp-fusion', 'sdm-constructs', 'hits-walk', 'nash-pack'];

const EXPECTED_ARMS = new Map([
  ['baseline-v1', []],
  ...V2_FEATURES.map((feature) => [`+${feature}`, [feature]]),
  ['full-v2', V2_FEATURES],
  ...TRACK_A.map((feature) => [`+${feature}`, [feature]]),
  ['v2-candidate', [...V2_FEATURES, ...TRACK_A]],
  ...TRACK_B.map((feature) => [`+${feature}`, [feature]]),
  ['full-v3', [...V2_FEATURES, ...TRACK_A, ...TRACK_B]],
]);

test('registers Track A and Track B arms with their lever sets', async () => {
  assert.deepEqual(RETRIEVAL_ARMS, [...EXPECTED_ARMS.keys()]);
  const seen = new Map();
  await runRetrievalAblation({
    tasks: [{ id: 't0', stratum: 'lexical', prompt: 'update the rate limit' }],
    gold: { t0: { files: ['src/rate.mjs'] } },
    evaluate: ({ arm, features }) => {
      seen.set(arm, [...features]);
      return null;
    },
  });
  for (const [name, features] of EXPECTED_ARMS) assert.deepEqual(seen.get(name), features, name);
});

function armReport(name, comparisons, summary = []) {
  return { name, observed: 2, missing: 0, summary, comparisons };
}

const comparison = (stratum, metric, favorableDelta, verdict = 'inconclusive') =>
  ({ stratum, metric, paired: 2, lowerIsBetter: false, favorableDelta, ci95: null, verdict });

test('zero-regression bars pass at exactly zero and fail below it', () => {
  const report = { tasks: 2, samples: 1000, seed: 42, arms: [
    { name: 'baseline-v1', observed: 2, missing: 0, summary: [], comparisons: [] },
    armReport('+anchor-fix', [
      comparison('lexical', 'recallAt10', 0),
      comparison('lexical', 'reciprocalRank', -0.05, 'regressed'),
      comparison('vocabulary-gap', 'reciprocalRank', 0.1, 'improved'),
    ], [
      { stratum: 'composite', tasks: 2, metrics: {
        'minSubtaskCoverage@1024': { value: 0.85, measured: 2 },
        'minSubtaskCoverage@2048': { value: 0.5, measured: 2 },
        'meanSubtaskRecall@1024': { value: 0.99, measured: 2 },
      } },
    ]),
  ] };
  const { gates, cleared } = evaluateRetrievalGates(report);
  assert.equal(cleared, false);
  assert.equal(gates.length, 5);
  assert.deepEqual(gates.filter(({ gate }) => gate.includes('Recall@10')).map(({ verdict }) => verdict), ['pass']);
  assert.deepEqual(gates.filter(({ gate }) => gate.includes('MRR')).map(({ verdict }) => verdict).sort(), ['fail', 'pass']);
  assert.deepEqual(gates.filter(({ gate }) => gate.startsWith('minSubtaskCoverage')).map(({ verdict }) => verdict).sort(), ['fail', 'pass']);
});

test('unmeasured deltas and missing scale rows never clear the gate', () => {
  const { gates, cleared } = evaluateRetrievalGates({ tasks: 1, samples: 1000, seed: 42, arms: [
    { name: 'baseline-v1', observed: 1, missing: 0, summary: [], comparisons: [] },
    armReport('+anchor-fix', [comparison('lexical', 'recallAt10', null, 'insufficient-tasks')]),
  ] });
  assert.equal(gates.length, 1);
  assert.equal(gates[0].verdict, 'unmeasured');
  assert.equal(cleared, false);
  assert.deepEqual(evaluateRetrievalGates(null), { gates: [], cleared: false });
});

test('warm 10k-file map and why bars read the candidate p50 and ignore other counts', () => {
  const scale = [
    { count: 500, command: 'map', candidate: { p50Ms: 99 } },
    { count: 10_000, command: 'map', candidate: { p50Ms: 80 } },
    { count: 10_000, command: 'why', candidate: { p50Ms: 15.1 } },
    { count: 10_000, command: 'brief', candidate: { p50Ms: 1 } },
  ];
  const { gates, cleared } = evaluateRetrievalGates(null, scale);
  assert.equal(gates.length, 2);
  assert.deepEqual(gates.map(({ gate, verdict }) => [gate, verdict]).sort(), [
    ['warm 10000 map p50 <= 80 ms', 'pass'], ['warm 10000 why p50 <= 15 ms', 'fail'],
  ]);
  assert.equal(cleared, false);
  assert.equal(PROMOTION_GATE_BARS.latencyCount, 10_000);
});

test('a run clears only when every bar passes', () => {
  const report = { tasks: 2, samples: 1000, seed: 42, arms: [
    { name: 'baseline-v1', observed: 2, missing: 0, summary: [], comparisons: [] },
    armReport('v2-candidate', [
      comparison('lexical', 'recallAt10', 0),
      comparison('lexical', 'reciprocalRank', 0.2, 'improved'),
      comparison('vocabulary-gap', 'reciprocalRank', 0),
    ]),
  ] };
  const scale = [
    { count: 10_000, command: 'map', candidate: { p50Ms: 79.9 } },
    { count: 10_000, command: 'why', candidate: { p50Ms: 15 } },
  ];
  const { gates, cleared } = evaluateRetrievalGates(report, scale);
  assert.equal(cleared, true);
  assert.ok(gates.length >= 5);
  assert.ok(gates.every(({ verdict }) => verdict === 'pass'));
});

test('rendered reports carry the promotion gate table and its clearance state', () => {
  const report = { tasks: 2, samples: 1000, seed: 42, arms: [
    { name: 'baseline-v1', observed: 2, missing: 0, summary: [], comparisons: [] },
    armReport('+anchor-fix', [comparison('lexical', 'recallAt10', -0.01, 'regressed')]),
  ] };
  const failing = renderRetrievalAblation(report);
  assert.match(failing, /Promotion gates — NOT CLEARED/);
  assert.match(failing, /\| \+anchor-fix \| zero lexical Recall@10 regression \| -0\.010000 \| fail \|/);
  const passing = renderRetrievalAblation({ ...report, arms: report.arms.map((arm) =>
    arm.name === 'baseline-v1' ? arm : { ...arm, comparisons: [comparison('lexical', 'recallAt10', 0)] }) });
  assert.match(passing, /Promotion gates — CLEARED/);
});

test('phase profiler times all five map phases with the engine primitives', async () => {
  const graph = { files: [{ path: 'src/a.mjs' }], symbols: [], edges: [], fieldedRows: [], nativeLexical: false, cochange: [] };
  let clock = 0;
  const measure = () => {
    clock = 0;
    return measureMapPhases({ root: null, graph, task: 'update the rate limit', now: () => (clock += 1) });
  };
  const first = await measure();
  const repeat = await measure();
  assert.deepEqual(first, repeat);
  // The fake clock advances once per `now()` call and each phase times exactly
  // two, so every phase lands on exactly 1 ms and the wiring is exact.
  assert.deepEqual(first, { ftsMs: 1, entityMs: 1, graphMs: 1, couplingMs: 1, packMs: 1, ranked: 0 });
});
